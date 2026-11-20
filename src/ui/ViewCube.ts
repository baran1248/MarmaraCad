import * as THREE from "three";
import type { ViewName } from "../viewport/Viewport";
import { icon } from "./icons";
import { hydrateIcons } from "./icons";

export class ViewCube {
  private cube: HTMLElement;
  private tmpQ = new THREE.Quaternion();
  private tmpM = new THREE.Matrix4();
  onView: (name: ViewName) => void = () => undefined;
  onHome: () => void = () => undefined;

  constructor(container: HTMLElement) {
    container.innerHTML = `
      <div class="vc-scene">
        <div class="vc-cube">
          <div class="vc-face front" data-view="front">FRONT</div>
          <div class="vc-face back" data-view="back">BACK</div>
          <div class="vc-face right" data-view="right">RIGHT</div>
          <div class="vc-face left" data-view="left">LEFT</div>
          <div class="vc-face top" data-view="top">TOP</div>
          <div class="vc-face bottom" data-view="bottom">BOTTOM</div>
        </div>
      </div>
      <button class="vc-home" title="Isometric view">${icon("home")}</button>
      <div class="vc-axis"><i class="ax-x">X</i><i class="ax-y">Y</i><i class="ax-z">Z</i></div>
    `;
    this.cube = container.querySelector(".vc-cube")!;
    container.querySelectorAll<HTMLElement>("[data-view]").forEach((face) => {
      face.addEventListener("click", () => this.onView(face.dataset.view as ViewName));
    });
    container.querySelector(".vc-home")?.addEventListener("click", () => this.onHome());
    hydrateIcons();
  }

  sync(camera: THREE.Camera): void {
    this.tmpQ.copy(camera.quaternion).invert();
    this.tmpM.makeRotationFromQuaternion(this.tmpQ);
    this.cube.style.transform = `matrix3d(${this.tmpM.elements.map((v) => v.toFixed(5)).join(",")})`;
  }
}
