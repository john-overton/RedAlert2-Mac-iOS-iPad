import { EventType } from "@/game/event/EventType";
import { TriggerCondition } from "@/game/trigger/TriggerCondition";
export class DestroyedAllCondition extends TriggerCondition {
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
            return !!owner && !owner.getOwnedObjects(true).some((obj: any) => true && !obj.rules.insignificant && !obj.isDestroyed);
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
            const isTargetTechno = target.isTechno();
            const isTargetOwner = target.owner.country?.id === this.houseId;
            const hasNoRemainingObjects = !target.owner.getOwnedObjects(true).length;
            return isTargetTechno && isTargetOwner && hasNoRemainingObjects;
        });
        if (hasDestroyedAll) {
            this.allDestroyed = true;
        }
        return hasDestroyedAll;
    }
}
