import { Action } from './Action';
import { ActionType } from './ActionType';

/** Server-scheduled control transition; recorded so replays start AI on the same tick. */
export class AiTakeoverAction extends Action {
    constructor(private readonly game: any) { super(ActionType.AiTakeover); }
    unserialize(_data: Uint8Array): void {}
    process(): void { this.game.botManager.takeOverPlayer(this.player, this.game); }
    print(): string { return '[AI takeover]'; }
}
