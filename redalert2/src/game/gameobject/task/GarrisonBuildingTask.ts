import { BuildingGarrisonEvent } from "@/game/event/BuildingGarrisonEvent";
import { EnterBuildingTask } from "@/game/gameobject/task/EnterBuildingTask";
export class GarrisonBuildingTask extends EnterBuildingTask {
    isAllowed(e: any): boolean {
        return (!this.target.isDestroyed &&
            !!this.target.garrisonTrait?.canBeOccupied() &&
            this.target.garrisonTrait.units.length <
                this.target.garrisonTrait.maxOccupants &&
            !(this.target.garrisonTrait.units.length &&
                this.target.garrisonTrait.units[0].owner !== e.owner) &&
            (this.target.owner.isNeutral || this.game.areFriendly(e, this.target)) &&
            !e.mindControllableTrait?.isActive());
    }
    onEnter(e: any): void {
        this.game.limboObject(e, {
            selected: false,
            controlGroup: this.game
                .getUnitSelection()
                .getOrCreateSelectionModel(e)
                .getControlGroupNumber(),
        });
        let t = this.target.garrisonTrait;
        // Occupying a neutral (civilian) building claims it; entering an
        // own/allied garrisonable like the Bio Reactor must not.
        if (!t.units.length && (this.target.owner.isNeutral || this.game.campaign?.isCivilianHouse(this.target.owner))) {
            t.previousCivilianOwner = this.target.owner;
            e.owner.buildingsCaptured++;
            this.game.changeObjectOwner(this.target, e.owner);
            this.game.events.dispatch(new BuildingGarrisonEvent(this.target));
        }
        t.units.push(e);
        if (this.target.rules.occupantsPowerBonus && this.target.rules.power > 0) {
            this.target.owner.powerTrait?.updateFrom(this.target, "update", this.game);
        }
        t.updateOccupantWeapons(this.game);
    }
}
