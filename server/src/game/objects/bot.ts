import type { Game } from "../game";
import { Player } from "./player";
import * as net from "../../../../shared/net/net";
import { v2, type Vec2 } from "../../../../shared/utils/v2";
import { math } from "../../../../shared/utils/math";
import { GameConfig } from "../../../../shared/gameConfig";
import { util } from "../../../../shared/utils/util";
import { BotSocket } from "./botSocket";
import { randomUUID } from "node:crypto";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import type { Obstacle } from "./obstacle";
import type { Loot } from "./loot";
import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import type { GunDef } from "../../../../shared/defs/objectsTypings";

enum BotState {
    IDLE,
    LOOTING,
    ATTACKING,
    SEEKING_LOOTBOX,
    BREAKING_LOOTBOX,
}

export class Bot {
    private player: Player;
    private state: BotState = BotState.IDLE;
    private targetLoot?: Loot;
    private targetEnemy?: Player;
    private targetObstacle?: Obstacle;
    private moveDirection = v2.create(0, 0);
    private aimDirection = v2.create(1, 0);
    private lastStateChangeTime = 0;
    private stateChangeInterval = 0;
    private reloadCheckTimer = 0;
    private strafeDirection = 1;
    private strafeChangeTimer = 0;

    constructor(private game: Game, pos?: Vec2, name?: string) {
        const botPos = pos ?? this.getRandomSpawnPosition();
        const socketId = randomUUID();

        // Create a dummy join message for the bot player
        const joinMsg = new net.JoinMsg();
        joinMsg.protocol = GameConfig.protocolVersion;
        joinMsg.matchPriv = "";
        joinMsg.questPriv = "";
        joinMsg.name = name ?? `Bot_${Math.random().toString(16).slice(2, 8)}`;
        joinMsg.useTouch = false;
        joinMsg.isMobile = false;
        joinMsg.bot = true;
        joinMsg.loadout = new net.JoinMsg().loadout;

        // Create player with dummy socket
        this.player = new Player(
            this.game,
            botPos,
            0,
            joinMsg.name,
            socketId,
            joinMsg,
            "127.0.0.1",
            "127.0.0.1",
            null,
        );

        // Register bot as a regular player
        this.game.playerBarn.activatePlayer(this.player);
        this.randomizeStateChangeInterval();
    }

    private getRandomSpawnPosition(): Vec2 {
        const mapWidth = this.game.map.width;
        const mapHeight = this.game.map.height;
        const padding = 50;
        return v2.create(
            util.random(padding, mapWidth - padding),
            util.random(padding, mapHeight - padding),
        );
    }

    private randomizeStateChangeInterval(): void {
        this.stateChangeInterval = util.random(2, 5);
        this.lastStateChangeTime = 0;
    }

    getPlayer(): Player {
        return this.player;
    }

    /**
     * Check if bot has a usable gun equipped
     */
    private hasGun(): boolean {
        const primary = this.player.weapons[GameConfig.WeaponSlot.Primary];
        const secondary = this.player.weapons[GameConfig.WeaponSlot.Secondary];
        return !!(primary.type || secondary.type);
    }

    /**
     * Check if bot has ammo for current gun
     */
    private hasAmmoForCurrentGun(): boolean {
        const curWeapon = this.player.weapons[this.player.curWeapIdx];
        if (!curWeapon.type) return false;

        const def = GameObjectDefs[curWeapon.type] as GunDef;
        if (!def || def.type !== "gun") return false;

        // Check if gun has ammo in clip or inventory
        const clipAmmo = curWeapon.ammo;
        const invAmmo = this.player.inventory[def.ammo] || 0;
        return clipAmmo > 0 || invAmmo > 0;
    }

    /**
     * Get the best gun slot to use
     */
    private getBestGunSlot(): number | null {
        const primary = this.player.weapons[GameConfig.WeaponSlot.Primary];
        const secondary = this.player.weapons[GameConfig.WeaponSlot.Secondary];

        // Prefer primary if it has ammo
        if (primary.type) {
            const def = GameObjectDefs[primary.type] as GunDef;
            if (def && def.type === "gun") {
                const invAmmo = this.player.inventory[def.ammo] || 0;
                if (primary.ammo > 0 || invAmmo > 0) {
                    return GameConfig.WeaponSlot.Primary;
                }
            }
        }

        // Try secondary
        if (secondary.type) {
            const def = GameObjectDefs[secondary.type] as GunDef;
            if (def && def.type === "gun") {
                const invAmmo = this.player.inventory[def.ammo] || 0;
                if (secondary.ammo > 0 || invAmmo > 0) {
                    return GameConfig.WeaponSlot.Secondary;
                }
            }
        }

        return null;
    }

    /**
     * Find nearest breakable obstacle (crates, barrels, etc.)
     */
    private findNearestLootBox(range: number): Obstacle | undefined {
        let closest: Obstacle | undefined;
        let closestDist = range;

        for (const obstacle of this.game.map.obstacles) {
            // Skip if not destructible or already destroyed
            if (!obstacle.destructible || obstacle.dead || obstacle.destroyed) continue;

            // Skip if different layer
            if (obstacle.layer !== this.player.layer && obstacle.layer !== 0) continue;

            // Check if it's a loot container (has loot to drop)
            if (!obstacle.loot || obstacle.loot.length === 0) continue;

            const dist = v2.distance(this.player.pos, obstacle.pos);
            if (dist < closestDist) {
                closestDist = dist;
                closest = obstacle;
            }
        }

        return closest;
    }

    /**
     * Find nearest loot on the ground (prioritize guns)
     */
    private findNearestLoot(range: number): Loot | undefined {
        const loots = this.game.lootBarn.loots;
        let closestGun: Loot | undefined;
        let closestGunDist = range;
        let closestOther: Loot | undefined;
        let closestOtherDist = range;

        for (const loot of loots) {
            if (loot.destroyed) continue;
            if (loot.layer !== this.player.layer && loot.layer !== 0) continue;

            const def = GameObjectDefs[loot.type];
            if (!def) continue;

            const dist = v2.distance(this.player.pos, loot.pos);

            // Prioritize guns if we don't have one
            if (def.type === "gun" && !this.hasGun()) {
                if (dist < closestGunDist) {
                    closestGunDist = dist;
                    closestGun = loot;
                }
            } else if (
                def.type === "ammo" ||
                def.type === "heal" ||
                def.type === "boost" ||
                def.type === "scope" ||
                def.type === "chest" ||
                def.type === "helmet" ||
                def.type === "backpack"
            ) {
                if (dist < closestOtherDist) {
                    closestOtherDist = dist;
                    closestOther = loot;
                }
            }
        }

        // Return gun first if we need one, otherwise other loot
        return closestGun ?? closestOther;
    }

    /**
     * Find nearest enemy player
     */
    private findNearestEnemy(range: number): Player | undefined {
        const players = this.game.playerBarn.livingPlayers;
        let closest: Player | undefined;
        let closestDist = range;

        for (const player of players) {
            if (player === this.player) continue;
            if (player.dead || player.disconnected) continue;
            if (player.layer !== this.player.layer && player.layer !== 0) continue;

            const dist = v2.distance(this.player.pos, player.pos);
            if (dist < closestDist) {
                closestDist = dist;
                closest = player;
            }
        }

        return closest;
    }

    update(dt: number): void {
        if (this.player.dead) return;

        this.lastStateChangeTime += dt;
        this.reloadCheckTimer += dt;
        this.strafeChangeTimer += dt;

        // Change strafe direction periodically
        if (this.strafeChangeTimer >= util.random(1, 3)) {
            this.strafeChangeTimer = 0;
            this.strafeDirection = Math.random() > 0.5 ? 1 : -1;
        }

        // Check for reload every 0.5 seconds
        if (this.reloadCheckTimer >= 0.5) {
            this.reloadCheckTimer = 0;
            this.checkAndReload();
        }

        this.updateState(dt);
        this.updateMovement();
        this.updateActions(dt);
        this.applyInputs();
    }

    private checkAndReload(): void {
        const curWeapon = this.player.weapons[this.player.curWeapIdx];
        if (!curWeapon.type) return;

        const def = GameObjectDefs[curWeapon.type] as GunDef;
        if (!def || def.type !== "gun") return;

        // Reload if clip is empty and we have ammo in inventory
        if (curWeapon.ammo === 0) {
            const invAmmo = this.player.inventory[def.ammo] || 0;
            if (invAmmo > 0 && !this.player.isReloading()) {
                this.player.weaponManager.tryReload();
            }
        }
    }

    private updateState(dt: number): void {
        // Priority-based state machine
        const nearestEnemy = this.findNearestEnemy(200);
        const hasGun = this.hasGun();

        // If we have a gun and see an enemy, attack!
        if (nearestEnemy && hasGun && this.hasAmmoForCurrentGun()) {
            this.state = BotState.ATTACKING;
            this.targetEnemy = nearestEnemy;
            this.targetLoot = undefined;
            this.targetObstacle = undefined;
            return;
        }

        // If we don't have a gun, prioritize getting one
        if (!hasGun) {
            // First, check for guns on the ground
            const nearestLoot = this.findNearestLoot(150);
            if (nearestLoot) {
                const def = GameObjectDefs[nearestLoot.type];
                if (def && def.type === "gun") {
                    this.state = BotState.LOOTING;
                    this.targetLoot = nearestLoot;
                    this.targetObstacle = undefined;
                    this.targetEnemy = undefined;
                    return;
                }
            }

            // No guns on ground, find a loot box to break
            const nearestLootBox = this.findNearestLootBox(200);
            if (nearestLootBox) {
                const dist = v2.distance(this.player.pos, nearestLootBox.pos);
                if (dist <= 3) {
                    this.state = BotState.BREAKING_LOOTBOX;
                } else {
                    this.state = BotState.SEEKING_LOOTBOX;
                }
                this.targetObstacle = nearestLootBox;
                this.targetLoot = undefined;
                this.targetEnemy = undefined;
                return;
            }
        }

        // If we have a gun but no ammo, look for ammo or more loot boxes
        if (hasGun && !this.hasAmmoForCurrentGun()) {
            const nearestLoot = this.findNearestLoot(150);
            if (nearestLoot) {
                this.state = BotState.LOOTING;
                this.targetLoot = nearestLoot;
                return;
            }

            const nearestLootBox = this.findNearestLootBox(200);
            if (nearestLootBox) {
                const dist = v2.distance(this.player.pos, nearestLootBox.pos);
                if (dist <= 3) {
                    this.state = BotState.BREAKING_LOOTBOX;
                } else {
                    this.state = BotState.SEEKING_LOOTBOX;
                }
                this.targetObstacle = nearestLootBox;
                return;
            }
        }

        // Otherwise, periodic state changes for looting or idling
        if (this.lastStateChangeTime >= this.stateChangeInterval) {
            const nearestLoot = this.findNearestLoot(150);
            if (nearestLoot) {
                this.state = BotState.LOOTING;
                this.targetLoot = nearestLoot;
            } else {
                // Look for loot boxes to break even when we have a gun
                const nearestLootBox = this.findNearestLootBox(150);
                if (nearestLootBox) {
                    const dist = v2.distance(this.player.pos, nearestLootBox.pos);
                    if (dist <= 3) {
                        this.state = BotState.BREAKING_LOOTBOX;
                    } else {
                        this.state = BotState.SEEKING_LOOTBOX;
                    }
                    this.targetObstacle = nearestLootBox;
                } else {
                    this.state = BotState.IDLE;
                    this.targetLoot = undefined;
                }
            }
            this.targetEnemy = undefined;
            this.randomizeStateChangeInterval();
        }
    }

    private updateMovement(): void {
        v2.set(this.moveDirection, v2.create(0, 0));

        switch (this.state) {
            case BotState.IDLE: {
                // Random wandering
                if (Math.random() < 0.05) {
                    const randomDir = v2.randomUnit();
                    v2.set(this.moveDirection, randomDir);
                }
                break;
            }

            case BotState.LOOTING: {
                if (this.targetLoot && !this.targetLoot.destroyed) {
                    const dirToLoot = v2.sub(this.targetLoot.pos, this.player.pos);
                    const distToLoot = v2.length(dirToLoot);
                    if (distToLoot > 1.5) {
                        v2.set(
                            this.moveDirection,
                            v2.normalizeSafe(dirToLoot, v2.create(1, 0)),
                        );
                    }
                    v2.set(this.aimDirection, v2.normalizeSafe(dirToLoot, this.aimDirection));
                } else {
                    this.state = BotState.IDLE;
                    this.targetLoot = undefined;
                }
                break;
            }

            case BotState.SEEKING_LOOTBOX: {
                if (
                    this.targetObstacle &&
                    !this.targetObstacle.dead &&
                    !this.targetObstacle.destroyed
                ) {
                    const dirToBox = v2.sub(this.targetObstacle.pos, this.player.pos);
                    const distToBox = v2.length(dirToBox);
                    if (distToBox > 2.5) {
                        v2.set(
                            this.moveDirection,
                            v2.normalizeSafe(dirToBox, v2.create(1, 0)),
                        );
                    }
                    v2.set(this.aimDirection, v2.normalizeSafe(dirToBox, this.aimDirection));
                } else {
                    this.state = BotState.IDLE;
                    this.targetObstacle = undefined;
                }
                break;
            }

            case BotState.BREAKING_LOOTBOX: {
                if (
                    this.targetObstacle &&
                    !this.targetObstacle.dead &&
                    !this.targetObstacle.destroyed
                ) {
                    const dirToBox = v2.sub(this.targetObstacle.pos, this.player.pos);
                    v2.set(this.aimDirection, v2.normalizeSafe(dirToBox, this.aimDirection));
                    // Stay close but not inside
                    const dist = v2.length(dirToBox);
                    if (dist > 3) {
                        v2.set(
                            this.moveDirection,
                            v2.normalizeSafe(dirToBox, v2.create(1, 0)),
                        );
                    }
                } else {
                    this.state = BotState.IDLE;
                    this.targetObstacle = undefined;
                }
                break;
            }

            case BotState.ATTACKING: {
                if (this.targetEnemy && !this.targetEnemy.dead) {
                    const dirToEnemy = v2.sub(this.targetEnemy.pos, this.player.pos);
                    const distToEnemy = v2.length(dirToEnemy);

                    // Strafe around enemy while keeping distance
                    const perpDir = v2.create(-dirToEnemy.y, dirToEnemy.x);

                    if (distToEnemy < 15) {
                        // Too close, back up while strafing
                        const backDir = v2.mul(
                            v2.normalizeSafe(dirToEnemy, v2.create(1, 0)),
                            -0.5,
                        );
                        const strafe = v2.mul(
                            v2.normalizeSafe(perpDir, v2.create(0, 1)),
                            this.strafeDirection * 0.5,
                        );
                        v2.set(this.moveDirection, v2.add(backDir, strafe));
                    } else if (distToEnemy > 50) {
                        // Too far, move closer
                        v2.set(
                            this.moveDirection,
                            v2.normalizeSafe(dirToEnemy, v2.create(1, 0)),
                        );
                    } else {
                        // Good range, strafe
                        v2.set(
                            this.moveDirection,
                            v2.mul(
                                v2.normalizeSafe(perpDir, v2.create(1, 0)),
                                this.strafeDirection * 0.7,
                            ),
                        );
                    }

                    v2.set(
                        this.aimDirection,
                        v2.normalizeSafe(dirToEnemy, this.aimDirection),
                    );
                } else {
                    this.state = BotState.IDLE;
                    this.targetEnemy = undefined;
                }
                break;
            }
        }
    }

    private updateActions(dt: number): void {
        // Reset shooting
        this.player.shootStart = false;
        this.player.shootHold = false;

        switch (this.state) {
            case BotState.ATTACKING: {
                if (this.targetEnemy && !this.targetEnemy.dead) {
                    // Make sure we're using a gun
                    const bestGunSlot = this.getBestGunSlot();
                    if (bestGunSlot !== null && this.player.curWeapIdx !== bestGunSlot) {
                        this.player.weaponManager.setCurWeapIndex(bestGunSlot);
                    }

                    const dist = v2.distance(this.player.pos, this.targetEnemy.pos);
                    const curWeapon = this.player.weapons[this.player.curWeapIdx];

                    // Only shoot if we have a gun with ammo
                    if (curWeapon.type && curWeapon.ammo > 0 && dist < 150) {
                        this.player.shootStart = true;
                        this.player.shootHold = true;
                    }
                }
                break;
            }

            case BotState.LOOTING: {
                // Auto-pickup when close to loot
                const closestLoot = this.player.getClosestLoot();
                if (closestLoot) {
                    this.player.pickupLoot(closestLoot);
                }
                break;
            }

            case BotState.BREAKING_LOOTBOX: {
                if (
                    this.targetObstacle &&
                    !this.targetObstacle.dead &&
                    !this.targetObstacle.destroyed
                ) {
                    // Switch to melee to break crates
                    if (this.player.curWeapIdx !== GameConfig.WeaponSlot.Melee) {
                        this.player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Melee);
                    }

                    const dist = v2.distance(this.player.pos, this.targetObstacle.pos);
                    if (dist <= 4) {
                        // Melee attack the crate
                        this.player.shootStart = true;
                        this.player.shootHold = true;
                    }
                } else {
                    // Crate destroyed, look for loot
                    this.state = BotState.IDLE;
                    this.targetObstacle = undefined;
                }
                break;
            }

            case BotState.SEEKING_LOOTBOX: {
                // Check if we arrived at the loot box
                if (this.targetObstacle && !this.targetObstacle.dead) {
                    const dist = v2.distance(this.player.pos, this.targetObstacle.pos);
                    if (dist <= 3) {
                        this.state = BotState.BREAKING_LOOTBOX;
                    }
                }
                break;
            }

            case BotState.IDLE: {
                // Try to pick up any nearby loot while wandering
                const closestLoot = this.player.getClosestLoot();
                if (closestLoot) {
                    this.player.pickupLoot(closestLoot);
                }
                break;
            }
        }
    }

    private applyInputs(): void {
        const inputMsg = new net.InputMsg();

        // Movement
        inputMsg.moveLeft = this.moveDirection.x < -0.3;
        inputMsg.moveRight = this.moveDirection.x > 0.3;
        inputMsg.moveUp = this.moveDirection.y > 0.3;
        inputMsg.moveDown = this.moveDirection.y < -0.3;

        // Aiming
        inputMsg.toMouseDir = v2.normalizeSafe(this.aimDirection, v2.create(1, 0));
        inputMsg.toMouseLen = 50;

        // Shooting
        inputMsg.shootStart = this.player.shootStart;
        inputMsg.shootHold = this.player.shootHold;

        // Apply the input
        this.player.handleInput(inputMsg);
    }
}
