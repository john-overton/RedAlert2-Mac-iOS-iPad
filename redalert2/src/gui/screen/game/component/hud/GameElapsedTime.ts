import * as THREE from 'three';
import { jsx } from '@/gui/jsx/jsx';
import { UiObject } from '@/gui/UiObject';
import { UiComponent, UiComponentProps } from '@/gui/jsx/UiComponent';
import { HtmlContainer } from '@/gui/HtmlContainer';
import { UiText } from '@/gui/component/UiText';
import { SpriteUtils } from '@/engine/gfx/SpriteUtils';
import { formatTimeDuration } from '@/util/format';

interface GameElapsedTimeProps extends UiComponentProps {
    sidebarModel: { readonly currentGameTime: number };
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex?: number;
}

/** Simulation time: pauses and lockstep waits never advance this clock. */
export class GameElapsedTime extends UiComponent<GameElapsedTimeProps> {
    declare private background: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    declare private text: UiText;
    private lastGameTime?: number;

    createUiObject(): UiObject {
        const { x, y, width, height } = this.props;
        const object = new UiObject(new THREE.Object3D(), new HtmlContainer());
        object.setPosition(x, y);
        const geometry = SpriteUtils.createRectGeometry(width, height);
        geometry.translate(width / 2, height / 2, 0);
        this.background = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
            color: 0x000000,
            opacity: 0.75,
            transparent: true,
            side: THREE.DoubleSide,
        }));
        this.background.frustumCulled = false;
        return object;
    }

    defineChildren() {
        const { width, height, zIndex = 6 } = this.props;
        return jsx('fragment', null,
            jsx('mesh', { zIndex }, this.background),
            jsx(UiText, {
                ref: (text: UiText) => { this.text = text; },
                value: '', textColor: '#ffffff', width, height, zIndex: zIndex + 1,
            }));
    }

    onFrame() {
        const seconds = this.props.sidebarModel.currentGameTime;
        if (seconds !== this.lastGameTime) {
            this.text.setValue(`Time ${formatTimeDuration(seconds)}`);
            this.lastGameTime = seconds;
        }
    }

    onDispose() {
        this.background.geometry.dispose();
        this.background.material.dispose();
    }
}
