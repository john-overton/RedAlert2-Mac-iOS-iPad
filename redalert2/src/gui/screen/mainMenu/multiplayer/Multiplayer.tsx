import React from 'react';
import { LobbyForm } from '@/gui/screen/mainMenu/lobby/component/LobbyForm';
import './multiplayer.css';

export interface ConnectionFields {
    playerName: string;
    serverName: string;
    password: string;
    port: string;
    address: string;
}

export interface MultiplayerProps {
    fields: ConnectionFields;
    busy: boolean;
    error?: string;
    canHost: boolean;
    lobbyProps?: any;
    serverName?: string;
    addresses: string[];
    status?: string;
    ready?: boolean;
    canReady?: boolean;
    managedPlayers?: { id: number; name: string }[];
    contentStatus?: string;
    contentBusy?: boolean;
    canManageContent?: boolean;
    hasContent?: boolean;
    onContentFiles: (files: File[]) => void;
    onRemoveContent: () => void;
    onRetryContent: () => void;
    onCancelContent: () => void;
    recent: string[];
    onField: (key: keyof ConnectionFields, value: string) => void;
    onHost: () => void;
    onJoin: () => void;
    onReady: () => void;
    onKick: (id: number) => void;
    onMakeAdmin: (id: number) => void;
}

export function Multiplayer(props: MultiplayerProps) {
    const field = (key: keyof ConnectionFields, label: string, type = 'text', placeholder?: string) => (
        <label className={`mp-field${key === 'address' ? ' mp-address-field' : ''}`}><span>{label}</span><input type={type} value={props.fields[key]}
            onChange={event => props.onField(key, event.target.value)} disabled={props.busy}
            maxLength={key === 'address' ? 255 : key === 'port' ? 5 : key === 'playerName' ? 24 : key === 'serverName' ? 32 : 64}
            autoComplete={type === 'password' ? 'new-password' : 'off'} spellCheck={false}
            placeholder={placeholder} inputMode={key === 'port' ? 'numeric' : undefined}/></label>
    );
    if (props.lobbyProps) {
        return <div className="multiplayer-lobby">
            <div className="mp-room-heading"><strong>{props.serverName}</strong><span>{props.status}</span></div>
            {props.addresses.length > 0 && <div className="mp-addresses">Join by address: {props.addresses.join(' · ')}</div>}
            {props.error && <div className="mp-error" role="alert">{props.error}</div>}
            <details className="mp-content" open={Boolean(props.contentStatus)}><summary>Maps and Custom Units</summary>
                {props.canManageContent && <label>Host content files<input aria-label="Host content files" type="file" multiple
                    accept=".map,.mpr,.yrm,.ini,.shp,.vxl,.hva,.pal,.tmp,.wav,.csf"
                    disabled={props.contentBusy || props.ready} onChange={event => {
                        props.onContentFiles(Array.from(event.target.files ?? [])); event.target.value = '';
                    }}/></label>}
                <div role="status">{props.contentStatus || 'Select a custom map and its unit rules, art and resources.'}</div>
                {props.contentBusy ? <button className="dialog-button" onClick={props.onCancelContent}>Cancel Transfer</button> : <>
                    {props.hasContent && <button className="dialog-button" onClick={props.onRetryContent} disabled={props.ready}>Verify Content</button>}
                    {props.canManageContent && props.hasContent && <button className="dialog-button" onClick={props.onRemoveContent} disabled={props.ready}>Remove Content</button>}
                </>}
            </details>
            <LobbyForm {...props.lobbyProps} beforeChatContent={<><div className="mp-ready-bar">
                <span>{props.ready ? 'Ready for battle' : !props.canReady ? 'Waiting for map and content verification.' : 'Choose your side, color and team, then click Ready.'}</span>
                <button className="dialog-button" type="button" disabled={!props.canReady} onClick={props.onReady}>{props.ready ? 'Cancel Ready' : 'Ready'}</button>
            </div>
                {Boolean(props.managedPlayers?.length) && <details className="mp-host-controls"><summary>Manage Players</summary>
                    {props.managedPlayers!.map(player => <div key={player.id}><span>{player.name}</span>
                        <button className="dialog-button" type="button" onClick={() => props.onMakeAdmin(player.id)}>Make Host</button>
                        <button className="dialog-button" type="button" onClick={() => props.onKick(player.id)}>Kick</button>
                    </div>)}
                </details>}
            </>}/>
        </div>;
    }
    return <div className="opts general-opts multiplayer-entry">
        <fieldset><legend>Commander</legend>{field('playerName', 'Player name')}</fieldset>
        <div className="mp-connection-columns">
            <form onSubmit={event => { event.preventDefault(); props.onHost(); }}>
                <fieldset><legend>Create Game</legend>
                    <p>Host a battle and share your address with the other commanders.</p>
                    {field('serverName', 'Game name')}
                    {field('port', 'Port', 'text', '1620')}
                    {field('password', 'Password', 'password', 'Optional')}
                    <button className="dialog-button" type="submit" disabled={props.busy || !props.canHost}>Create Game</button>
                    {!props.canHost && <p className="mp-hint">Hosting is available in the Linux desktop app. You can join a host by address here.</p>}
                </fieldset>
            </form>
            <form onSubmit={event => { event.preventDefault(); props.onJoin(); }}>
                <fieldset><legend>Join Game</legend>
                    <p>Enter the host’s address and password to join their battle.</p>
                    {field('address', 'Address', 'text', '192.168.1.20:1620')}
                    {field('password', 'Password', 'password', 'If required')}
                    <button className="dialog-button" type="submit" disabled={props.busy}>Join Game</button>
                    <p className="mp-hint">Default port: 1620. IPv6 and ra2:// addresses are accepted.</p>
                </fieldset>
            </form>
        </div>
        {props.recent.length > 0 && <fieldset className="mp-recent"><legend>Recent Addresses</legend>
            {props.recent.map(address => <button className="mp-address-button" type="button" key={address} disabled={props.busy}
                onClick={() => props.onField('address', address)}>{address}</button>)}
        </fieldset>}
        <div className="mp-status" role="status">{props.busy ? 'Establishing connection…' : 'Direct connection · Each player must have the same game version and assets.'}</div>
        {props.error && <div className="mp-error" role="alert">{props.error}</div>}
    </div>;
}
