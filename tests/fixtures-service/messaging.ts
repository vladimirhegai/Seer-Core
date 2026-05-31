// Fixture: Messaging producers and consumers across Kafka / SQS / SNS /
// RabbitMQ / NATS / Redis pub-sub. The resolver should rendezvous each
// producer with its matching consumer by topic / queue.

declare const producer: any;
declare const consumer: any;
declare const sqs: any;
declare const sns: any;
declare const channel: any;
declare const nc: any;
declare const redis: any;

// ── Kafka ────────────────────────────────────────────────────────────────────
export async function produceOrders(): Promise<void> {
  await producer.send({ topic: 'orders', messages: [{ value: 'x' }] });
}

export async function produceShipments(): Promise<void> {
  await producer.send({ topic: 'shipments', messages: [{ value: 'y' }] });
}

export function handleOrder(message: unknown): void { void message; }

export async function subscribeOrders(): Promise<void> {
  // Single-topic subscribe.
  await consumer.subscribe({ topic: 'orders' });
  consumer.run({ eachMessage: handleOrder });
}

export async function subscribeMulti(): Promise<void> {
  await consumer.subscribe({ topics: ['shipments', 'invoices'] });
}

// ── SQS ──────────────────────────────────────────────────────────────────────
export async function enqueueJob(): Promise<void> {
  await sqs.sendMessage({
    QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/job-queue',
    MessageBody: '{}',
  });
}

export async function consumeJob(): Promise<void> {
  await sqs.receiveMessage({
    QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/job-queue',
  });
}

// ── SNS ──────────────────────────────────────────────────────────────────────
export async function notifySubscribers(): Promise<void> {
  await sns.publish({
    TopicArn: 'arn:aws:sns:us-east-1:123456789012:user-events',
    Message: 'created',
  });
}

// ── RabbitMQ ─────────────────────────────────────────────────────────────────
export function publishEvent(): void {
  channel.publish('events', 'user.created', Buffer.from('{}'));
}

export function pushToQ(): void {
  channel.sendToQueue('mailer-queue', Buffer.from('{}'));
}

export function rabbitHandler(message: unknown): void { void message; }

export function subscribeMailer(): void {
  channel.consume('mailer-queue', rabbitHandler);
}

// ── NATS ─────────────────────────────────────────────────────────────────────
export async function natsPublish(): Promise<void> {
  await nc.publish('user.created', Buffer.from('{}'));
}

export async function natsSubscribe(): Promise<void> {
  await nc.subscribe('user.created');
}

// ── Redis pub-sub ────────────────────────────────────────────────────────────
export function redisPub(): void {
  redis.publish('chan:notifications', 'hello');
}

export function redisSub(): void {
  redis.subscribe('chan:notifications');
}
