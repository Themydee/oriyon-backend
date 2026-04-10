import amqplib from "amqplib";
const EXCHANGE = "oriyon.events";
let channel = null;
let connection = null;
// ─────────────────────────────────────────────
// CONNECT
// ─────────────────────────────────────────────
export async function connectRabbitMQ(url) {
    let retries = 10;
    while (retries > 0) {
        try {
            connection = await amqplib.connect(url);
            channel = await connection.createChannel();
            await channel.assertExchange(EXCHANGE, "topic", { durable: true });
            console.log("[auth-service][RabbitMQ] Connected");
            // Graceful shutdown
            connection.on("close", () => {
                console.error("[auth-service][RabbitMQ] Connection closed. Reconnecting...");
                setTimeout(() => connectRabbitMQ(url), 5000);
            });
            connection.on("error", (err) => {
                console.error("[auth-service][RabbitMQ] Connection error:", err.message);
            });
            return channel;
        }
        catch {
            retries--;
            console.error(`[auth-service][RabbitMQ] Retrying... (${retries} left)`);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
    throw new Error("[auth-service][RabbitMQ] Connection failed after all retries");
}
// ─────────────────────────────────────────────
// PUBLISH
// ─────────────────────────────────────────────
export async function publishEvent(routingKey, payload) {
    if (!channel)
        throw new Error("RabbitMQ channel not ready");
    channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), { persistent: true, contentType: "application/json" });
    console.log(`[auth-service][RabbitMQ] Published → ${routingKey}`);
}
// ─────────────────────────────────────────────
// SUBSCRIBE
// ─────────────────────────────────────────────
export async function subscribeToEvent(routingKey, handler) {
    if (!channel)
        throw new Error("RabbitMQ channel not ready");
    const queueName = `auth-service.${routingKey}`;
    // Durable queue survives broker restarts
    await channel.assertQueue(queueName, { durable: true });
    await channel.bindQueue(queueName, EXCHANGE, routingKey);
    // Only fetch one message at a time — don't overwhelm the handler
    channel.prefetch(1);
    channel.consume(queueName, async (msg) => {
        if (!msg)
            return;
        try {
            const payload = JSON.parse(msg.content.toString());
            console.log(`[auth-service][RabbitMQ] Received ← ${routingKey}`);
            await handler(payload);
            channel.ack(msg); // success — remove from queue
        }
        catch (err) {
            console.error(`[auth-service][RabbitMQ] Handler error for ${routingKey}:`, err);
            // nack without requeue — prevents infinite loops on bad messages
            channel.nack(msg, false, false);
        }
    });
    console.log(`[auth-service][RabbitMQ] Subscribed ← ${routingKey} (queue: ${queueName})`);
}
