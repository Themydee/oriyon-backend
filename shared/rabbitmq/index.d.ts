import { Channel } from "amqplib";
export declare function connectRabbitMQ(url: string): Promise<Channel>;
export declare function publishEvent(routingKey: string, payload: Record<string, unknown>): Promise<void>;
export declare function consumeEvent(routingKey: string, queueName: string, handler: (payload: Record<string, unknown>) => Promise<void>): Promise<void>;
//# sourceMappingURL=index.d.ts.map