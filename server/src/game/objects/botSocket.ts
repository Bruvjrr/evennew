/**
 * Dummy WebSocket implementation for bots
 * Allows bots to interface with the Player class without a real socket
 */
export class BotSocket {
    readonly isBot = true;

    send(_data: Uint8Array | Buffer): void {
        // Bots don't send data
    }

    close(): void {
        // Bots don't close
    }

    end(): void {
        // Bots don't end
    }
}
