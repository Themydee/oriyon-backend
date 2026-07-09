"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectRabbitMQ = connectRabbitMQ;
exports.publishEvent = publishEvent;
exports.consumeEvent = consumeEvent;
const amqplib_1 = __importDefault(require("amqplib"));
const EXCHANGE_NAME = "oriyon.events";
const EXCHANGE_TYPE = "topic";
let connection = null;
let channel = null;
async function connectRabbitMQ(url) {
    if (channel)
        return channel;
    let retries = 10;
    while (retries > 0) {
        try {
            const conn = await amqplib_1.default.connect(url);
            connection = conn;
            const ch = await conn.createChannel();
            channel = ch;
            await ch.assertExchange(EXCHANGE_NAME, EXCHANGE_TYPE, { durable: true });
            conn.on("close", () => {
                console.error("[RabbitMQ] Connection closed. Reconnecting...");
                channel = null;
                connection = null;
                setTimeout(() => connectRabbitMQ(url), 5000);
            });
            console.log("[RabbitMQ] Connected successfully");
            return ch;
        }
        catch (err) {
            console.error(`[RabbitMQ] Connection failed. Retrying... (${retries} left)`);
            retries--;
            await new Promise((res) => setTimeout(res, 5000));
        }
    }
    throw new Error("[RabbitMQ] Could not connect after multiple retries");
}
async function publishEvent(routingKey, payload) {
    if (!channel)
        throw new Error("[RabbitMQ] Channel not initialised");
    const buffer = Buffer.from(JSON.stringify(payload));
    channel.publish(EXCHANGE_NAME, routingKey, buffer, {
        persistent: true,
        contentType: "application/json",
    });
    console.log(`[RabbitMQ] Published → ${routingKey}`, payload);
}
async function consumeEvent(routingKey, queueName, handler) {
    if (!channel)
        throw new Error("[RabbitMQ] Channel not initialised");
    await channel.assertQueue(queueName, { durable: true });
    await channel.bindQueue(queueName, EXCHANGE_NAME, routingKey);
    channel.prefetch(1);
    channel.consume(queueName, async (msg) => {
        if (!msg)
            return;
        try {
            const payload = JSON.parse(msg.content.toString());
            await handler(payload);
            channel.ack(msg);
        }
        catch (err) {
            console.error(`[RabbitMQ] Error processing message on ${routingKey}:`, err);
            channel.nack(msg, false, false); // dead-letter, don't requeue
        }
    });
    console.log(`[RabbitMQ] Consuming → ${routingKey} (queue: ${queueName})`);
}
//# sourceMappingURL=index.js.map