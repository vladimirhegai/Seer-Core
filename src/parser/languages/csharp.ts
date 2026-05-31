import type Parser from 'web-tree-sitter';
import type { SymbolDef, SymbolKind, ServiceCallDef } from '../../types.js';
import type { LanguageExtractor } from '../walker.js';
import { firstLine } from '../walker.js';

// C# HttpClient async method names → HTTP verb.
const CS_HTTP_CLIENT_METHODS = new Map<string, string>([
  ['GetAsync', 'GET'], ['GetStringAsync', 'GET'], ['GetByteArrayAsync', 'GET'],
  ['GetStreamAsync', 'GET'], ['GetFromJsonAsync', 'GET'],
  ['PostAsync', 'POST'], ['PostAsJsonAsync', 'POST'],
  ['PutAsync', 'PUT'], ['PutAsJsonAsync', 'PUT'],
  ['PatchAsync', 'PATCH'],
  ['DeleteAsync', 'DELETE'],
  ['SendAsync', 'ANY'],
]);

function csLooksLikeHttpTarget(s: string): boolean {
  if (!s) return false;
  if (s.startsWith('/')) return true;
  if (/^https?:\/\//i.test(s)) return true;
  return false;
}

/**
 * C# extractor — covers .cs files. Common in Godot (since Godot 4 supports
 * C# scripting via partial classes) and Unity.
 *
 * The C# tree-sitter grammar mostly mirrors Java's structure with a few
 * naming differences (`invocation_expression` rather than `method_invocation`,
 * `object_creation_expression` for `new`, etc.).
 */
const CS_BRANCH_NODES = new Set<string>([
  'if_statement', 'while_statement', 'do_statement', 'for_statement', 'for_each_statement',
  'switch_section', 'catch_clause', 'conditional_expression',
]);

const CS_NESTING_NODES = new Set<string>([
  'if_statement', 'while_statement', 'do_statement', 'for_statement', 'for_each_statement',
  'switch_statement', 'catch_clause', 'try_statement',
]);

const CS_CANDIDATE_NODE_TYPES = [
  // tryExtractDefinition
  'method_declaration',
  'class_declaration',
  'interface_declaration',
  'struct_declaration',
  'enum_declaration',
  'constructor_declaration',
  'record_declaration',
  'delegate_declaration',
  // tryExtractCallName (invocation + object_creation)
  'invocation_expression',
  'object_creation_expression',
  // tryExtractImport
  'using_directive',
] as const;

export const csharpExtractor: LanguageExtractor = {
  languageName: 'csharp',
  extensions: ['.cs'],
  branchNodeTypes: CS_BRANCH_NODES,
  nestingNodeTypes: CS_NESTING_NODES,
  candidateNodeTypes: CS_CANDIDATE_NODE_TYPES,

  tryExtractDefinition(node: Parser.SyntaxNode): SymbolDef | null {
    switch (node.type) {
      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'method', node);
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'class', node);
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'interface', node);
      }

      case 'struct_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'struct', node);
      }

      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'enum', node);
      }

      case 'constructor_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'constructor', node);
      }

      // record Foo(int X, string Y);  — a C# 9+ record (acts like a class)
      case 'record_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'class', node);
      }

      // delegate void Foo(int x);  — captured as a `type` symbol
      case 'delegate_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'type', node);
      }

      default:
        return null;
    }
  },

  tryExtractCallName(node: Parser.SyntaxNode): string | null {
    // foo()  or  obj.method()
    if (node.type === 'invocation_expression') {
      const funcNode = node.childForFieldName('function');
      if (!funcNode) return null;
      if (funcNode.type === 'identifier') return funcNode.text;
      if (funcNode.type === 'member_access_expression') {
        return funcNode.childForFieldName('name')?.text ?? null;
      }
      // generic call: foo<int>() parses as invocation_expression whose
      // function is `generic_name`
      if (funcNode.type === 'generic_name') {
        return funcNode.childForFieldName('name')?.text
          ?? funcNode.namedChildren[0]?.text
          ?? null;
      }
      return null;
    }

    // new Foo() — count as a call to Foo
    if (node.type === 'object_creation_expression') {
      const typeNode = node.childForFieldName('type');
      if (!typeNode) return null;
      if (typeNode.type === 'identifier') return typeNode.text;
      if (typeNode.type === 'generic_name') {
        return typeNode.childForFieldName('name')?.text
          ?? typeNode.namedChildren[0]?.text
          ?? null;
      }
      if (typeNode.type === 'qualified_name') {
        // ns.Class → Class
        return typeNode.childForFieldName('name')?.text ?? null;
      }
      return null;
    }

    return null;
  },

  tryExtractImport(node: Parser.SyntaxNode): string | null {
    // using System;  or  using System.Collections.Generic;
    if (node.type === 'using_directive') {
      // The grammar stores the imported namespace as a child (qualified_name
      // or identifier). The `name` field isn't always set, so scan children.
      for (const child of node.namedChildren) {
        if (child.type === 'qualified_name' || child.type === 'identifier') {
          return child.text;
        }
      }
    }
    return null;
  },

  /**
   * C# HttpClient calls: client.GetAsync("/api/x"), httpClient.PostAsJsonAsync(url, body).
   * The first string-literal arg is taken as the URL.
   */
  tryExtractServiceCalls(node: Parser.SyntaxNode): ServiceCallDef[] | null {
    if (node.type !== 'invocation_expression') return null;
    const fn = node.childForFieldName('function');
    if (!fn || fn.type !== 'member_access_expression') return null;
    const name = fn.childForFieldName('name')?.text;
    if (!name) return null;
    const verb = CS_HTTP_CLIENT_METHODS.get(name);
    if (!verb) return null;

    const args = node.childForFieldName('arguments');
    if (!args) return null;
    // arguments → argument_list with `argument` children, each wrapping an expr.
    let first: Parser.SyntaxNode | null = null;
    for (const a of args.namedChildren) {
      if (a.type === 'argument') {
        first = a.namedChildren[0];
        break;
      }
      first = a; break;
    }
    if (!first) return null;
    let raw: string | null = null;
    if (first.type === 'string_literal' || first.type === 'verbatim_string_literal') {
      raw = first.text.replace(/^@?["']|["']$/g, '');
    } else if (first.type === 'interpolated_string_expression') {
      // C# interpolated string $"…" — pick the literal_string parts.
      let text = '';
      for (const c of first.namedChildren) {
        if (c.type === 'interpolated_string_text') text += c.text;
      }
      if (text) raw = text;
    }
    if (!raw || !csLooksLikeHttpTarget(raw)) return null;

    return [{
      protocol: 'http',
      method: verb,
      rawTarget: raw.slice(0, 240),
      framework: 'HttpClient',
      line: node.startPosition.row,
      confidence: 0.85,
    }];
  },
};

function mkDef(name: string, kind: SymbolKind, node: Parser.SyntaxNode): SymbolDef {
  return {
    name,
    kind,
    lineStart: node.startPosition.row,
    lineEnd:   node.endPosition.row,
    colStart:  node.startPosition.column,
    colEnd:    node.endPosition.column,
    signature: firstLine(node),
  };
}
