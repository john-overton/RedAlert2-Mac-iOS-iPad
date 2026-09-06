import { TriggerCondition } from '../TriggerCondition';

/** Attached objects discovered or selected by the human campaign player. */
export class PlayerObservationCondition extends TriggerCondition {
    check(game: any): any[] {
        const player = game.localPlayer;
        if (!game.campaign || !player) return [];
        const shroud = game.mapShroudTrait.getPlayerShroud(player);
        return this.targets.filter(object => object.isSpawned && !object.isDestroyed &&
            (this.event.type === 33
                ? game.campaign.selectedUnitIds.has(object.id)
                : game.map.tileOccupation.calculateTilesForGameObject(object.tile, object)
                    .some((tile: any) => !shroud?.isShrouded(tile, object.tileElevation))));
    }
}
