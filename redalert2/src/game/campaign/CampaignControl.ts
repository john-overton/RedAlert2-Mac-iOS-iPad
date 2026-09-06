/** PlayerControl gives orders across scenario houses without changing trigger ownership. */
export function canControl(player: any, object: any): boolean {
    return !!player && !!object && (object.owner === player || player.campaignControlHouses?.has(object.owner) === true);
}
export function controllableObjects(player: any): any[] {
    if (!player) return [];
    return [...new Set([player, ...player.campaignControlHouses ?? []])].flatMap(owner => owner.getOwnedObjects());
}
