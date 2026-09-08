import { ChatRecipientType } from '@/network/chat/ChatMessage';
import { RECIPIENT_TEAM, RECIPIENT_OBSERVERS } from '@/network/gservConfig';
export class ChatTypingHandler {
    private isTyping = false;
    constructor(private keyboardHandler: any, private arrowScrollHandler: any, private messageList: any, private chatHistory: any) { }
    startTyping(): void {
        if (!this.isTyping) {
            if (this.messageList.observerChat) this.chatHistory.lastComposeTarget.value = {
                type: ChatRecipientType.Channel, name: RECIPIENT_OBSERVERS,
            };
            this.keyboardHandler.pause();
            this.arrowScrollHandler.cancel?.();
            this.arrowScrollHandler.pause();
            this.messageList.isComposing = true;
            this.isTyping = true;
        }
    }
    endTyping(): void {
        if (this.isTyping) {
            this.keyboardHandler.unpause();
            this.arrowScrollHandler.unpause();
            this.messageList.isComposing = false;
            this.isTyping = false;
        }
    }
    handleKeyDown(event: KeyboardEvent): boolean {
        if (this.isTyping) return true;
        if (event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
        const target = event.target as HTMLElement | null;
        if (target?.matches?.('input, textarea, select, [contenteditable="true"]')) return false;
        if (event.key === 'Enter') {
            event.preventDefault();
            this.startTyping();
            return true;
        }
        else if (event.key === 'Backspace') {
            event.preventDefault();
            this.chatHistory.lastComposeTarget.value = {
                type: ChatRecipientType.Channel,
                name: this.messageList.observerChat ? RECIPIENT_OBSERVERS : RECIPIENT_TEAM,
            };
            this.startTyping();
            return true;
        }
        return false;
    }
    handleKeyUp(event: KeyboardEvent): void {
    }
    dispose(): void {
        this.keyboardHandler.unpause();
        this.arrowScrollHandler.unpause();
        this.messageList.isComposing = false;
    }
}
