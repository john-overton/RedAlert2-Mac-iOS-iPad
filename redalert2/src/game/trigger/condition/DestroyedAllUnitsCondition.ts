import { ObjectType } from "@/engine/type/ObjectType";
import { EventType } from "@/game/event/EventType";
import { TriggerCondition } from "@/game/trigger/TriggerCondition";
export class DestroyedAllUnitsCondition extends TriggerCondition {
    private allDestroyed: boolean;
    private houseId: number;
    constructor(params: any, trigger: any) {
        super(params, trigger);
        this.allDestroyed = false;
        this.houseId = Number(params.params[1]);
    }
    check(context: any, events: any[]): boolean {
        if (context.campaign) {
            const owner = context.getAllPlayers().find((p: any) => p.country?.id === this.houseId);
            return !!owner && !owner.getOwnedObjects(true).some((obj: any) => obj.isUnit() && !obj.rules.insignificant && !obj.isDestroyed);
        }
        if (this.allDestroyed) {
            return true;
        }
        const hasDestroyedAll = events.some((event) => {
            if (event.type !== EventType.ObjectDestroy) {
                return false;
            }
            const target = event.target;
            if (!target.isTechno()) return false;
            if (!target.isUnit() || target.owner.country?.id !== this.houseId) {
                return false;
            }
            return !this.hasUnitsLeft(target.owner);
        });
        if (hasDestroyedAll) {
            this.allDestroyed = true;
        }
        return hasDestroyedAll;
    }
    private hasUnitsLeft(owner: any): boolean {
        const unitTypes = [
            ObjectType.Aircraft,
            ObjectType.Vehicle,
            ObjectType.Infantry,
        ];
        for (const type of unitTypes) {
            if (owner.getOwnedObjectsByType(type, true).length) {
                return true;
            }
        }
        return false;
    }
}
