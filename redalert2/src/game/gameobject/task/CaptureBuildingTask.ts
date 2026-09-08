import { BuildStatus } from "@/game/gameobject/Building";
import { BuildingCaptureEvent } from "@/game/event/BuildingCaptureEvent";
import { Warhead } from "@/game/Warhead";
import { CollisionType } from "@/game/gameobject/unit/CollisionType";
import { ZoneType } from "@/game/gameobject/unit/ZoneType";
import { EnterBuildingTask } from "@/game/gameobject/task/EnterBuildingTask";
/** Keep the capture cursor and entry-time validation in agreement. */
export function canCaptureBuilding(game: any, engineer: any, target: any): boolean {
    return !!(engineer.isInfantry() && engineer.rules.engineer &&
        target?.isBuilding() && target.rules.capturable && !target.isDestroyed &&
        target.buildStatus !== BuildStatus.BuildDown && !game.areFriendly(engineer, target));
}
export function shouldDamageBeforeCapture(game: any, target: any): boolean {
    const general = game.rules.general;
    return !!(game.gameOpts.multiEngineer &&
        (!target.rules.needsEngineer || !general.engineerAlwaysCaptureTech) &&
        target.healthTrait.health > 100 * general.engineerCaptureLevel);
}
export class CaptureBuildingTask extends EnterBuildingTask {
    isAllowed(e: any): boolean {
        return canCaptureBuilding(this.game, e, this.target);
    }
    onEnter(t: any): void {
        this.game.unspawnObject(t);
        if (this.game.gameOpts.multiEngineer) {
            const generalRules = this.game.rules.general;
            if (shouldDamageBeforeCapture(this.game, this.target)) {
                let damage = Math.floor(generalRules.engineerDamage * this.target.healthTrait.maxHitPoints);
                const minHealth = Math.floor((1 - Math.floor(1 / generalRules.engineerDamage) * generalRules.engineerDamage) *
                    this.target.healthTrait.maxHitPoints);
                damage = Math.min(damage, this.target.healthTrait.getHitPoints() - minHealth);
                if (damage > 0) {
                    const warheadId = this.game.rules.combatDamage.c4Warhead;
                    const warhead = new Warhead(this.game.rules.getWarhead(warheadId));
                    warhead.detonate(this.game, damage, this.target.tile, 0, this.target.position.worldPosition, ZoneType.Ground, CollisionType.None, this.game.createTarget(this.target, this.target.tile), { player: t.owner, obj: t, weapon: undefined } as any, false, undefined, 0);
                    return;
                }
            }
        }
        t.owner.buildingsCaptured++;
        this.game.changeObjectOwner(this.target, t.owner);
        this.game.events.dispatch(new BuildingCaptureEvent(this.target));
    }
}
