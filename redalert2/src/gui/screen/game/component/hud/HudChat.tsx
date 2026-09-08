import React, { useEffect, useRef, useState } from "react";
import { ChatInput } from "@/gui/component/ChatInput";
import { RECIPIENT_ALL, RECIPIENT_TEAM, RECIPIENT_OBSERVERS } from "@/network/gservConfig";
type HudChatProps = {
    messageList: any;
    chatHistory: any;
    strings: any;
    onSubmit: (e: any) => void;
    onCancel: () => void;
};
export const HudChat: React.FC<HudChatProps & {
    isComposing: boolean;
    localPlayer?: {
        color: {
            asHexString: () => string;
        };
    };
}> = ({ messageList, chatHistory, strings, onSubmit, onCancel, isComposing, localPlayer, }) => {
    const [messages, setMessages] = useState(() => messageList.getRecentChatMessages().slice());
    const history = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const refresh = () => setMessages(messageList.getRecentChatMessages().slice());
        refresh();
        messageList.onNewMessage.subscribe(refresh);
        return () => messageList.onNewMessage.unsubscribe(refresh);
    }, [messageList]);
    useEffect(() => {
        if (history.current) history.current.scrollTop = history.current.scrollHeight;
    }, [messages, isComposing]);
    if (!isComposing)
        return null;
    const forceColor = localPlayer?.color.asHexString() ?? "white";
    return (<div className="game-chat-console"><div className="game-chat-history" ref={history} role="log" aria-label="Recent chat messages">{messages.map((message: any, index: number) => <div key={index} style={{ color: message.color }}>{message.badge && <span style={{ color: message.badge.color }}>[{message.badge.label}] </span>}{message.text}</div>)}</div><div className="game-chat-hint">{messageList.observerChat ? "Enter to send · Observers only · Esc to cancel" : "Enter to send · Tab to change audience · Esc to cancel"}</div><ChatInput chatHistory={chatHistory} channels={messageList.observerChat ? [RECIPIENT_OBSERVERS] : [RECIPIENT_ALL, RECIPIENT_TEAM]} allowWhispers={!messageList.observerChat} className="game-chat-input" forceColor={forceColor} noCycleHint={true} submitEmpty={true} strings={strings} onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Escape")
                e.preventDefault();
            e.stopPropagation();
            (e.nativeEvent as KeyboardEvent & {
                stopImmediatePropagation?: () => void;
            }).stopImmediatePropagation?.();
        }} onKeyUp={(e: React.KeyboardEvent<HTMLInputElement>) => {
            e.stopPropagation();
            (e.nativeEvent as KeyboardEvent & {
                stopImmediatePropagation?: () => void;
            }).stopImmediatePropagation?.();
        }} onSubmit={(e: any) => {
            e.value.length ? onSubmit(e) : onCancel();
        }} onCancel={onCancel} onBlur={onCancel}/></div>);
};
