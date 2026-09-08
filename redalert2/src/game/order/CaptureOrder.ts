import { Order } from "./Order";
import { OrderType } from "./OrderType";
import { PointerType } from "@/engine/type/PointerType";
import { RangeHelper } from "@/game/gameobject/unit/RangeHelper";
import { CaptureBuildingTask, canCaptureBuilding, shouldDamageBeforeCapture } from "@/game/gameobject/task/CaptureBuildingTask";
import { OrderFeedbackType } from "./OrderFeedbackType";
export class CaptureOrder extends Order {
    private game: any;
    constructor(game: any) {
        super(OrderType.Capture);
        this.game = game;
        this.targetOptional = false;
        this.terminal = true;
        this.feedbackType = OrderFeedbackType.Capture;
    }
    getPointerType(isMini: boolean): PointerType {
        if (!this.isAllowed()) {
            return isMini ? PointerType.NoActionMini : PointerType.NoOccupy;
        }
        if (isMini) {
            return PointerType.OccupyMini;
        }
        if (shouldDamageBeforeCapture(this.game, this.target.obj)) {
            return PointerType.EngineerDamage;
        }
        return PointerType.Occupy;
    }
    isValid(): boolean {
        return (!(this.target.obj?.isDestroyed ||
            !this.target.obj?.isBuilding() ||
            !this.sourceObject.isInfantry()) &&
            this.target.obj.rules.capturable &&
            this.sourceObject.rules.engineer &&
            !this.game.areFriendly(this.sourceObject, this.target.obj));
    }
    isAllowed(): boolean {
        return canCaptureBuilding(this.game, this.sourceObject, this.target.obj);
    }
    process(): CaptureBuildingTask[] {
        return [new CaptureBuildingTask(this.game, this.target.obj)];
    }
    onAdd(tasks: any[], isQueued: boolean): boolean {
        if (!isQueued) {
            const existingCaptureTask = tasks.find((task) => task instanceof CaptureBuildingTask);
            if (this.isValid() &&
                this.isAllowed() &&
                existingCaptureTask &&
                !existingCaptureTask.isCancelling() &&
                existingCaptureTask.target === this.target.obj) {
                if (new RangeHelper(this.game.map.tileOccupation).isInTileRange(this.sourceObject, this.target.obj, 0, Math.SQRT2)) {
                    return false;
                }
            }
        }
        return true;
    }
}
