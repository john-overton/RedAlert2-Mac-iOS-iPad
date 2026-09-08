import { Action } from './Action';
import { ActionType } from './ActionType';
import { PlayerDroppedEvent } from '../event/PlayerDroppedEvent';

export class DestroyDisconnectedPlayerAction extends Action {
    constructor(private readonly game: any) { super(ActionType.DestroyDisconnectedPlayer); }
    unserialize(_data: Uint8Array): void {}
    process(): void {
        if (this.player.defeated || this.player.dropped) return;
        this.game.removeAllPlayerAssets(this.player);
        this.player.dropped = true;
        this.game.events.dispatch(new PlayerDroppedEvent(this.player, false));
    }
    print(): string { return '[Disconnected player eliminated]'; }
}
