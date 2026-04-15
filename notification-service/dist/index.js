"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const amqplib_1 = __importDefault(require("amqplib"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const rabbitUrl = process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
const exchange = process.env.RABBITMQ_EXCHANGE || "shop.events";
const run = async () => {
    const connection = await amqplib_1.default.connect(rabbitUrl);
    const channel = await connection.createChannel();
    await channel.assertExchange(exchange, "topic", { durable: false });
    const queue = await channel.assertQueue("", { exclusive: true });
    const events = ["order.created", "order.paid", "user.registered"];
    for (const eventKey of events) {
        await channel.bindQueue(queue.queue, exchange, eventKey);
    }
    console.log("notification-service listening for events...");
    channel.consume(queue.queue, (msg) => {
        if (!msg)
            return;
        const event = msg.fields.routingKey;
        const payload = msg.content.toString();
        console.log(`[NOTIFICATION] ${event} -> ${payload}`);
    });
};
run().catch((error) => {
    console.error("notification-service failed:", error);
    process.exit(1);
});
