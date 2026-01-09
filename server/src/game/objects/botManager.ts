import type { Game } from "../game";
import { Bot } from "./bot";

export class BotManager {
    private bots: Bot[] = [];
    private botCount: number;

    constructor(private game: Game, botCount: number = 50) {
        this.botCount = botCount;
    }

    /**
     * Initialize and spawn all bots
     */
    initBots(): void {
        for (let i = 0; i < this.botCount; i++) {
            const bot = new Bot(this.game, undefined, `Bot_${i + 1}`);
            this.bots.push(bot);
        }

        this.game.logger.info(`Spawned ${this.bots.length} bots`);
    }

    /**
     * Update all bots each game tick
     */
    update(dt: number): void {
        for (let i = this.bots.length - 1; i >= 0; i--) {
            const bot = this.bots[i];
            const player = bot.getPlayer();

            // Remove dead bots from the list
            if (player.dead && player.timeAlive > 10) {
                // Keep bot data for 10+ seconds after death, then remove
                this.bots.splice(i, 1);
                continue;
            }

            bot.update(dt);
        }
    }

    /**
     * Get all bots currently in the game
     */
    getBots(): Bot[] {
        return this.bots;
    }

    /**
     * Get the count of alive bots
     */
    getAliveBotCount(): number {
        return this.bots.filter((b) => !b.getPlayer().dead).length;
    }

    /**
     * Disable all bots (useful for testing)
     */
    disableBots(): void {
        this.bots = [];
    }
}
