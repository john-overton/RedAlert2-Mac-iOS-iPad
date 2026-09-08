export type WireData = string | Uint8Array;

/** Runtime adapters own sockets and timers; the core only sees messages. */
export interface ServerConnection {
    readonly remoteAddress: string;
    send(data: WireData): void;
    close(reason: string): void;
    onMessage(handler: (data: WireData) => void): void;
    onClose(handler: () => void): void;
}

export interface ServerTransport {
    listen(onConnection: (connection: ServerConnection) => void): void | Promise<void>;
    close(): void;
}
