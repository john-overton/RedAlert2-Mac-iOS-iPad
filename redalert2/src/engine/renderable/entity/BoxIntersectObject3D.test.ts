import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { BoxIntersectObject3D } from './BoxIntersectObject3D';

test('ground-unit hitbox covers the body above its feet, not underground', () => {
    const parent = new THREE.Group();
    parent.position.set(100, 200, 300); // Elevated terrain/bridge.
    const body = new BoxIntersectObject3D(new THREE.Vector3(10, 20, 10), true);
    parent.add(body);
    parent.updateMatrixWorld(true);
    const hitAt = (height: number) => {
        const ray = new THREE.Raycaster(new THREE.Vector3(100, height, 400), new THREE.Vector3(0, 0, -1));
        return ray.intersectObject(body).length;
    };
    expect(hitAt(219)).toBe(1);
    expect(hitAt(201)).toBe(1);
    expect(hitAt(199)).toBe(0);
    expect(hitAt(221)).toBe(0);
});
