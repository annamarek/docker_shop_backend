import amqp from "amqplib";
import dotenv from "dotenv";

dotenv.config();

const rabbitUrl = process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
const exchange = process.env.RABBITMQ_EXCHANGE || "shop.events";

const run = async (): Promise<void> => {
  const connection = await amqp.connect(rabbitUrl);
  const channel = await connection.createChannel();
  await channel.assertExchange(exchange, "topic", { durable: false });

  const queue = await channel.assertQueue("", { exclusive: true });
  const events = ["order.created", "order.paid", "user.registered"];

  for (const eventKey of events) {
    await channel.bindQueue(queue.queue, exchange, eventKey);
  }

  console.log("notification-service listening for events...");

  channel.consume(queue.queue, (msg) => {
    if (!msg) return;
    const event = msg.fields.routingKey;
    const payload = msg.content.toString();
    console.log(`[NOTIFICATION] ${event} -> ${payload}`);
  });
};

run().catch((error) => {
  console.error("notification-service failed:", error);
  process.exit(1);
});
