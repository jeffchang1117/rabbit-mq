const amqp = require("amqplib");
const QUEUE_METADATA = require("./data/exchange");
const rabbitmqUrl = "amqp://localhost:5672";

class QueueWorker {
  constructor() {}

  async connect() {
    try {
      const connection = await amqp.connect(rabbitmqUrl);
      this.channel = await connection.createChannel();
      console.log("connected RabbitMQ");
    } catch (error) {
      console.log("fail to connect RabbitMQ");
      throw error;
    }
  }

  async assertQueue(queueName, options = {}) {
    await this.channel.assertQueue(queueName, options);
  }

  async assertExchange(exchange, exchangeType, options = {}) {
    await this.channel.assertExchange(exchange, exchangeType, options);
  }

  async subscribeToQueues() {
    for (let data of QUEUE_METADATA) {
      await this.channel.assertExchange(data.exchange, data.exchangeType);

      await this.channel.assertQueue(data.queue, data.options);

      await this.channel.bindQueue(data.queue, data.exchange, data.routingKey);

      this.channel.consume(data.queueName, data.handler);
    }
  }

  getChannel() {
    if (this.channel) {
      return this.channel;
    }

    throw new Error("Invalid channel");
  }
  processMessage({ msg, action, requeue, allUpTo }) {
    switch (action) {
      case "ACK":
        this.channel.ack(msg);
        break;
      case "REJECT":
        this.channel.reject(msg);
        break;
      case "NACK":
        this.channel.nack(msg, allUpTo, requeue);
        break;
    }
  }

  async testing() {
    await this.channel.assertQueue("email-queue", {
      deadLetterExchange: "dlx_exchange",
      deadLetterRoutingKey: "dlx_key",
      durable: true,
    });

    await this.channel.assertQueue("dead-letter-queue", {
      deadLetterExchange: "main_exchange",
      deadLetterRoutingKey: "email-queue-key",
      durable: true,
    });

    await Promise.all([
      this.channel.bindQueue("email-queue", "main_exchange", "email-queue-key"),
      this.channel.bindQueue("dead-letter-queue", "dlx_exchange", "dlx_key"),
    ]);

    this.channel.consume("email-queue", (msg) => {
      console.log("rejectedMessage..", JSON.parse(msg.content.toString()));
      this.channel.nack(msg, false, false);
    });

    this.channel.consume("dead-letter-queue", (msg) => {
      console.log("dead-letter msg", JSON.parse(msg.content.toString()));
      console.log("x-death properties", msg.properties.headers["x-death"][0]);
      if (msg.properties.headers["x-death"][0].count > 4) {
        this.channel.ack(msg);
      } else {
        /**since we assert main_exchange and it's routing key as deadLetter,
          when dead letter reject msg it will g back to it's original route
        **/
        this.channel.reject(msg, false);
      }
    });
  }

  async bindExchangeQueue(exchange, routingKey, options = {}) {
    /*
     *One of the reason put empty string is because `fanout` exchange will broadcast message to each queue,
     *If we assertQueue with same queue name, only 1 consumer will receive the message as there are in the same queue.name
     *Passing empty string will automatically create random queue name and exclusive flag will delete thr queue after it closed
     */
    const { queue } = await this.channel.assertQueue("", options);

    // channel.prefetch(1); //ensure the queue doesn't keep dispatch message to consumer until they've ack the job
    await this.channel.bindQueue(queue, exchange, routingKey, options.headers);

    return queue;
  }

  consumeMessage(queue) {
    this.channel.consume(queue, (message) => {
      // Uncomment this to see the message properties and other info
      // console.log("message", message);
      console.log("Received", JSON.parse(message.content.toString()));
      this.channel.ack(message, false, true);
    });
  }

  async close() {
    await this.channel.close();
  }

  isValidExchangeType(exchangeType) {
    return ["fanout", "direct", "topic", "headers"].some(
      (exchange) => exchange === exchangeType
    );
  }

  consumeDeadLetterMessage(queue) {
    this.channel.consume(queue, (message) => {
      this.processDeadQueue(message);
    });
  }
  processDeadQueue(msg) {
    if (msg.properties.headers["x-death"][0].count > 4) {
      this.channel.ack(msg);
    } else {
      console.log("DEAD QUEUE", msg.properties.headers["x-death"]);
      this.channel.reject(msg, false);
    }
  }
}

const queueWorker = new QueueWorker();
module.exports = queueWorker;
