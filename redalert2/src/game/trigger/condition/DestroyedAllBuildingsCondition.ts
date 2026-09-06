import { EventType } from "@/game/event/EventType";
import { TriggerCondition } from "@/game/trigger/TriggerCondition";
export class DestroyedAllBuildingsCondition extends TriggerCondition {
    private allDestroyed: boolean = false;
    private houseId: number;
    constructor(params: any, trigger: any) {
        super(params, trigger);
        this.houseId = Number(params.params[1]);
    }
    check(context: any, events: any[]): boolean {
        if (context.campaign) {
            const owner = context.getAllPlayers().find((p: any) => p.country?.id === this.houseId);
            return !!owner && !owner.getOwnedObjects(true).some((obj: any) => obj.isBuilding() && !obj.rules.insignificant && !obj.isDestroyed);
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
            const isTargetBuilding = target.isBuilding();
            const isTargetOwner = target.owner.country?.id === this.houseId;
            const hasNoBuildings = !target.owner.buildings.size;
            return isTargetBuilding && isTargetOwner && hasNoBuildings;
        });
        if (hasDestroyedAll) {
            this.allDestroyed = true;
        }
        return hasDestroyedAll;
    }
}
