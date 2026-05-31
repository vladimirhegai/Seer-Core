import type Parser from 'web-tree-sitter';
import type { SymbolDef, ServiceCallDef } from '../../types.js';
import type { LanguageExtractor } from '../walker.js';
import { firstLine } from '../walker.js';

// Go HTTP-client method names. The receiver may be `http`, `http.DefaultClient`,
// or any user client (e.g. `myClient`).
const GO_HTTP_VERBS = new Set([
  'Get', 'Post', 'PostForm', 'Head', 'Do', 'Patch', 'Put', 'Delete', 'NewRequest',
]);

const GO_BRANCH_NODES = new Set<string>([
  'if_statement', 'for_statement', 'expression_case', 'default_case',
  'type_case', 'communication_case', 'select_statement',
]);

const GO_NESTING_NODES = new Set<string>([
  'if_statement', 'for_statement', 'expression_switch_statement',
  'type_switch_statement', 'select_statement',
]);

const GO_CANDIDATE_NODE_TYPES = [
  // tryExtractDefinition
  'function_declaration',
  'method_declaration',
  'type_declaration',
  // tryExtractCallName
  'call_expression',
  // tryExtractImport
  'import_spec',
] as const;

export const goExtractor: LanguageExtractor = {
  languageName: 'go',
  extensions: ['.go'],
  branchNodeTypes: GO_BRANCH_NODES,
  nestingNodeTypes: GO_NESTING_NODES,
  candidateNodeTypes: GO_CANDIDATE_NODE_TYPES,

  tryExtractDefinition(node: Parser.SyntaxNode): SymbolDef | null {
    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'function',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'method',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      // type Foo struct {} or type Foo interface {}
      case 'type_declaration': {
        // type_declaration contains one or more type_spec children
        for (const child of node.children) {
          if (child.type === 'type_spec') {
            const nameNode = child.childForFieldName('name');
            if (!nameNode) continue;
            const typeNode = child.childForFieldName('type');
            const kind = typeNode?.type === 'interface_type' ? 'interface'
                       : typeNode?.type === 'struct_type'    ? 'struct'
                       : 'type';
            return {
              name: nameNode.text,
              kind,
              lineStart: node.startPosition.row,
              lineEnd:   node.endPosition.row,
              colStart:  node.startPosition.column,
              colEnd:    node.endPosition.column,
              signature: firstLine(node),
            };
          }
        }
        return null;
      }

      default:
        return null;
    }
  },

  tryExtractCallName(node: Parser.SyntaxNode): string | null {
    if (node.type !== 'call_expression') return null;
    const funcNode = node.childForFieldName('function');
    if (!funcNode) return null;

    // foo()
    if (funcNode.type === 'identifier') return funcNode.text;

    // pkg.Func() or receiver.Method()
    if (funcNode.type === 'selector_expression') {
      return funcNode.childForFieldName('field')?.text ?? null;
    }

    return null;
  },

  tryExtractImport(node: Parser.SyntaxNode): string | null {
    // import_spec contains a "path" field (interpreted_string_literal)
    if (node.type === 'import_spec') {
      const pathNode = node.childForFieldName('path');
      return pathNode?.text?.replace(/['"]/g, '') ?? null;
    }
    return null;
  },

  /**
   * Go HTTP-client calls:
   *   http.Get("https://x/y")           ← yes
   *   http.Post("/api", "json", body)   ← yes
   *   client.Get("/api/users")          ← yes (any receiver, capital verb)
   *   http.NewRequest("GET", "/x", …)   ← yes (method = first string arg)
   */
  tryExtractServiceCalls(node: Parser.SyntaxNode): ServiceCallDef[] | null {
    if (node.type !== 'call_expression') return null;
    const fn = node.childForFieldName('function');
    if (!fn || fn.type !== 'selector_expression') return null;
    const recv = fn.childForFieldName('operand');
    const field = fn.childForFieldName('field');
    if (!recv || !field) return null;
    const verb = field.text;

    // v9 Track-H — gRPC client call:
    //   pb.NewUserServiceClient(conn).GetUser(ctx, &req)
    // recv is a call_expression to pb.New<X>ServiceClient(...) or pb.New<X>Client(...);
    // verb is the method (capitalized). We emit a service_call with operation
    // = "Service/Method" matching the .proto resolver.
    if (recv.type === 'call_expression' && verb && /^[A-Z]/.test(verb)) {
      const grpc = tryExtractGoGrpcCall(node, recv, verb);
      if (grpc) return [grpc];
    }

    if (!GO_HTTP_VERBS.has(verb)) return null;

    let framework: string;
    if (recv.text === 'http') framework = 'http';
    else if (recv.text === 'httputil') framework = 'httputil';
    else framework = 'http-client';

    const args = node.childForFieldName('arguments');
    if (!args) return null;
    const named = args.namedChildren;

    let method: string | undefined;
    let urlIdx = 0;
    if (verb === 'NewRequest' || verb === 'NewRequestWithContext') {
      const ctxOffset = verb === 'NewRequestWithContext' ? 1 : 0;
      const methodNode = named[ctxOffset];
      if (methodNode && methodNode.type === 'interpreted_string_literal') {
        method = methodNode.text.replace(/['"`]/g, '').toUpperCase();
      }
      urlIdx = ctxOffset + 1;
    } else if (verb === 'Do') {
      // http.Client.Do(req) doesn't expose the URL here; skip.
      return null;
    } else {
      method = verb === 'Get' ? 'GET'
            : verb === 'Post' ? 'POST'
            : verb === 'PostForm' ? 'POST'
            : verb === 'Head' ? 'HEAD'
            : verb === 'Patch' ? 'PATCH'
            : verb === 'Put' ? 'PUT'
            : verb === 'Delete' ? 'DELETE'
            : 'ANY';
    }

    const urlNode = named[urlIdx];
    if (!urlNode) return null;
    let raw: string | null = null;
    if (urlNode.type === 'interpreted_string_literal' || urlNode.type === 'raw_string_literal') {
      raw = urlNode.text.replace(/^[`"']|[`"']$/g, '');
    } else {
      return null;
    }
    if (!raw || !goLooksLikeHttpTarget(raw)) return null;

    return [{
      protocol: 'http',
      method: method ?? 'ANY',
      rawTarget: raw.slice(0, 240),
      framework,
      line: node.startPosition.row,
      confidence: 0.85,
    }];
  },
};

/**
 * v9 Track-H — detect a gRPC client stub call in Go.
 *
 * Pattern: `pb.NewUserServiceClient(conn).GetUser(ctx, &req)`
 *
 * `recv` is the inner call expression (`pb.NewUserServiceClient(conn)`); we
 * look at its callee to harvest the service name from `NewXServiceClient` or
 * `NewXClient`. The outer method (`GetUser`) becomes the rpc method.
 *
 * Returns a ServiceCallDef with:
 *   - protocol = 'grpc'
 *   - operation = 'Service/Method' (matches .proto-derived routes)
 *   - service   = 'UserService'
 *   - method    = 'GetUser'
 *
 * Returns null if the inner callee does not parse as a NewXClient
 * constructor — keeps determinism high (no false-positive on a chained
 * method call against an unrelated builder pattern).
 */
function tryExtractGoGrpcCall(
  outer: Parser.SyntaxNode,
  recv: Parser.SyntaxNode,
  rpcMethod: string,
): ServiceCallDef | null {
  const innerFn = recv.childForFieldName('function');
  if (!innerFn || innerFn.type !== 'selector_expression') return null;
  const innerField = innerFn.childForFieldName('field');
  if (!innerField) return null;
  const ctor = innerField.text;
  // Match `New(.*)(?:Service)?Client$`. Service is the middle capture if it ends
  // in "ServiceClient"; otherwise strip just "Client".
  const m = ctor.match(/^New([A-Z][A-Za-z0-9_]*?)(Service)?Client$/);
  if (!m) return null;
  const serviceName = m[1] + (m[2] ? 'Service' : '');
  const operation = `${serviceName}/${rpcMethod}`;
  return {
    protocol: 'grpc',
    method: rpcMethod.toUpperCase(),
    rawTarget: `${ctor}.${rpcMethod}`,
    framework: 'grpc-go',
    line: outer.startPosition.row,
    confidence: 0.9,
    operation,
    service: serviceName,
  };
}

function goLooksLikeHttpTarget(s: string): boolean {
  if (!s) return false;
  if (s.startsWith('/')) return true;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9_-]/.test(s)) return true;
  return false;
}
