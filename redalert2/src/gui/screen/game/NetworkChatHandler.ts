import { NetworkMatchSession } from '@/network/client/NetworkMatchSession';
import { ChatRecipientType } from '@/network/chat/ChatMessage';
import { RECIPIENT_ALL, RECIPIENT_TEAM } from '@/network/gservConfig';
import type { ServerMessage } from '@/network/server/Protocol';

/** Presents direct-server chat through the same HUD/history as legacy multiplayer. */
export class NetworkChatHandler {
    constructor(private match: NetworkMatchSession, private messageList: any, private chatHistory: any,
        private format: any, private game: any, private replayRecorder: any, private mutedPlayers: Set<string>) {}

    init(): void { this.match.onChat.subscribe(this.receive); }
    dispose(): void { this.match.onChat.unsubscribe(this.receive); }

    submitMessage(text: string, recipient: { type: ChatRecipientType; name: string }): void {
        if (!text.trim()) return;
        const to = recipient.type === ChatRecipientType.Whisper
            ? this.match.start.humanAssignments.find(player => player.name === recipient.name)?.clientId
            : recipient.name === RECIPIENT_TEAM ? 'team' : 'all';
        if (to !== undefined) this.match.sendChat(to, text);
    }

    private readonly receive = (packet: Extract<ServerMessage, { type: 'chat' }>): void => {
        const sender = this.match.start.humanAssignments.find(player => player.clientId === packet.clientId);
        if (!sender || this.mutedPlayers.has(sender.name)) return;
        const to = typeof packet.to === 'number'
            ? { type: ChatRecipientType.Whisper, name: this.match.start.humanAssignments.find(player => player.clientId === packet.to)?.name ?? '' }
            : { type: ChatRecipientType.Channel, name: packet.to === 'team' ? RECIPIENT_TEAM : RECIPIENT_ALL };
        const message = { from: sender.name, to, text: packet.text, time: new Date() };
        const color = to.type === ChatRecipientType.Whisper ? 'mediumpurple' : this.game.getPlayerByName(sender.name).color.asHexString();
        this.messageList.addChatMessage(`${this.format.formatPrefixPlain(message)} ${packet.text}`, color);
        this.chatHistory.addChatMessage(message);
        if (packet.to === 'all') this.replayRecorder?.recordChatMessage(this.game.currentTick, sender.name, packet.text);
    };
}
