import { GameSpeed } from '../GameSpeed';

export const campaignSpeedLabels = ['Slowest', 'Slow', 'Normal', 'Fast', 'Faster', 'Fastest'];
export const DEFAULT_CAMPAIGN_SPEED = 3;
const ticksPerSecond = [10, 15, 23, 30, 45, 60];

export function campaignSpeedFactor(level: number): number {
    const index = Number.isInteger(level) && level >= 1 && level <= 6 ? level : DEFAULT_CAMPAIGN_SPEED;
    return ticksPerSecond[index - 1] / GameSpeed.BASE_TICKS_PER_SECOND;
}
