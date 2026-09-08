import { NetworkMatchSession } from '@/network/client/NetworkMatchSession';
import { ChatRecipientType } from '@/network/chat/ChatMessage';
import { RECIPIENT_ALL, RECIPIENT_TEAM, RECIPIENT_OBSERVERS } from '@/network/gservConfig';
import type { ServerMessage } from '@/network/server/Protocol';
import type { ChatBadge } from './component/hud/viewmodel/MessageList';

const TEAM_BADGE_COLORS = ['#80cfff', '#ffcb80', '#9fe6a0', '#ff9fcd', '#c6b0ff', '#e4dc87', '#89e1db', '#e5b9a3'];
export function chatBadge(to: 'all' | 'team' | 'observers' | number, teamId: number): ChatBadge | undefined {
    if (to === 'all') return { label: 'All', color: '#dddddd' };
    if (to === 'observers') return { label: 'Observers', color: '#c6a0e8' };
    if (to === 'team') return teamId >= 0
        ? { label: `Team ${teamId + 1}`, color: TEAM_BADGE_COLORS[teamId % TEAM_BADGE_COLORS.length] }
        : { label: 'No team', color: '#bbbbbb' };
}

/** Presents server-stamped identities without consulting mutable lobby membership. */
export class NetworkChatHandler {
    constructor(private match: NetworkMatchSession, private messageList: any, private chatHistory: any,
        private format: any, private game: any, private replayRecorder: any, private mutedPlayers: Set<string>) {}

    init(): void {
        this.messageList.observerChat = this.match.isObserver?.() ?? false;
        this.match.onChat.subscribe(this.receive);
    }
    dispose(): void { this.match.onChat.unsubscribe(this.receive); }

    submitMessage(text: string, recipient: { type: ChatRecipientType; name: string }): void {
        if (!text.trim()) return;
        if (this.match.isObserver?.()) {
            if (recipient.type === ChatRecipientType.Channel && recipient.name === RECIPIENT_OBSERVERS) this.match.sendChat('observers', text);
            return;
        }
        if (recipient.name === RECIPIENT_OBSERVERS) return;
        const to = recipient.type === ChatRecipientType.Whisper
            ? this.match.start.humanAssignments.find(player => player.name === recipient.name)?.clientId
            : recipient.name === RECIPIENT_TEAM ? 'team' : 'all';
        if (to !== undefined) this.match.sendChat(to, text);
    }

    private readonly receive = (packet: Extract<ServerMessage, { type: 'chat' }>): void => {
        const sender = packet.sender;
        if (!sender || this.mutedPlayers.has(sender.name)) return;
        const to = typeof packet.to === 'number'
            ? { type: ChatRecipientType.Whisper, name: packet.recipient?.name ?? '' }
            : { type: ChatRecipientType.Channel, name: packet.to === 'team' ? RECIPIENT_TEAM : packet.to === 'observers' ? RECIPIENT_OBSERVERS : RECIPIENT_ALL };
        const badge = chatBadge(packet.to, sender.teamId);
        const colors = this.game.rules?.getMultiplayerColors?.();
        const gamePlayer = this.game.getAllPlayers?.().find((player: any) => player.name === sender.name);
        const color = (colors ? [...colors.values()][sender.colorId]?.asHexString() : undefined) ?? gamePlayer?.color.asHexString() ?? '#ffffff';
        const message = { from: sender.name, to, text: packet.text, time: new Date(),
            sender: { ...sender }, recipient: packet.recipient ? { ...packet.recipient } : undefined, senderColor: color, badge };
        const prefix = badge ? `${sender.name}:` : this.format.formatPrefixPlain(message);
        this.messageList.addChatMessage(`${prefix} ${packet.text}`, color, badge);
        this.chatHistory.addChatMessage(message);
        if (packet.to === 'all') this.replayRecorder?.recordChatMessage(this.game.currentTick, sender.name, packet.text);
    };
}
