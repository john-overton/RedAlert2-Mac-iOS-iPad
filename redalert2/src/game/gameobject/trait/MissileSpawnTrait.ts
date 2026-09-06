import { NotifyDestroy } from './interface/NotifyDestroy';
import { GameObject } from '@/game/gameobject/GameObject';
import { World } from '@/game/World';
export class MissileSpawnTrait {
    private warhead?: any;
    private damage?: number;
    private launcher?: GameObject;
    setWarhead(warhead: any): this {
        this.warhead = warhead;
        return this;
    }
    setDamage(damage: number): this {
        this.damage = damage;
        return this;
    }
    setLauncher(launcher: GameObject): this {
        this.launcher = launcher;
        return this;
    }
    [NotifyDestroy.onDestroy](gameObject: GameObject, world: World): void {
        // Impact damage is applied by AirSpawnTrait after the flight task.
        // Interception destroys the missile; it must not detonate the impact
        // warhead here, especially while another missile is still on the deck.
        this.dispose();
    }
    dispose(): void {
        this.launcher = undefined;
        this.warhead = undefined;
        this.damage = undefined;
    }
}
