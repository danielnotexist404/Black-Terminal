import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import aircraftUnitUrl from "../assets/battlefield/aircraft-unit.png";
import soldierUnitUrl from "../assets/battlefield/soldier-unit.png";
import tankUnitUrl from "../assets/battlefield/tank-unit.png";

export type BattlefieldTelemetry = {
  buyerShare: number;
  buyerDepth: number;
  sellerDepth: number;
  buyCount: number;
  sellCount: number;
  buyNotional: number;
  sellNotional: number;
  price: number;
  priceChangePercent: number;
};

type Side = "buy" | "sell";
type TankUnit = { group: THREE.Group; side: Side; phase: number; speed: number; lane: number; index: number };
type AircraftUnit = { group: THREE.Group; side: Side; phase: number; speed: number; altitude: number; lane: number; bomber?: boolean };
type SoldierUnit = { sprite: THREE.Sprite; side: Side; phase: number; speed: number; lane: number; rank: number; size: number; index: number };
type ProjectileUnit = { mesh: THREE.Mesh; side: Side; phase: number; speed: number; lane: number };
type ExplosionUnit = { group: THREE.Group; phase: number; speed: number; lane: number; side: Side };

const WORLD_WIDTH = 112;
const WORLD_DEPTH = 70;
const FRONT_SEGMENTS = 64;
const SELL_COLOR = new THREE.Color(0xff294d);
const BUY_COLOR = new THREE.Color(0x35f5a0);
const tempObject = new THREE.Object3D();
const tempColor = new THREE.Color();

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function seeded(seed: number) {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function terrainHeight(x: number, z: number) {
  return (
    Math.sin(x * 0.115) * 0.72 +
    Math.cos(z * 0.17) * 0.55 +
    Math.sin((x + z) * 0.072) * 0.65 +
    Math.cos((x - z) * 0.041) * 0.45
  );
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach((item) => {
    for (const value of Object.values(item)) {
      if (value instanceof THREE.Texture) value.dispose();
    }
    item.dispose();
  });
}

function ribbonGeometry(points: THREE.Vector3[], width: number) {
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  points.forEach((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const tangent = next.clone().sub(previous).normalize();
    const perpendicular = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize().multiplyScalar(width / 2);
    const left = point.clone().add(perpendicular);
    const right = point.clone().sub(perpendicular);
    vertices.push(left.x, left.y, left.z, right.x, right.y, right.z);
    const progress = index / Math.max(1, points.length - 1);
    uvs.push(0, progress, 1, progress);
    if (index < points.length - 1) {
      const offset = index * 2;
      indices.push(offset, offset + 2, offset + 1, offset + 1, offset + 2, offset + 3);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function makeLabelTexture(text: string, color: string, emphasis = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 112;
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, "rgba(4,6,8,0)");
  gradient.addColorStop(0.18, "rgba(4,6,8,.76)");
  gradient.addColorStop(0.82, "rgba(4,6,8,.76)");
  gradient.addColorStop(1, "rgba(4,6,8,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 12, canvas.width, 88);
  context.strokeStyle = color;
  context.globalAlpha = emphasis ? 0.72 : 0.32;
  context.strokeRect(80, 12, canvas.width - 160, 88);
  context.globalAlpha = 1;
  context.fillStyle = color;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `${emphasis ? 800 : 650} ${emphasis ? 42 : 34}px 'IBM Plex Mono', monospace`;
  context.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function loadUnitTexture(url: string, mirrored = false) {
  const texture = new THREE.TextureLoader().load(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.premultiplyAlpha = true;
  if (mirrored) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.repeat.x = -1;
    texture.offset.x = 1;
  }
  return texture;
}

function createUnitMaterial(url: string, side: Side) {
  return new THREE.SpriteMaterial({
    map: loadUnitTexture(url, side === "sell"),
    color: side === "buy" ? 0x68ffc2 : 0xff5a72,
    transparent: true,
    alphaTest: 0.035,
    depthWrite: false,
    toneMapped: false
  });
}

function createGroundedUnit(material: THREE.SpriteMaterial, width: number, height: number, side: Side) {
  const group = new THREE.Group();
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(width, height, 1);
  sprite.position.y = height * 0.37;
  sprite.renderOrder = 4;
  group.add(sprite);

  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(1, 24),
    new THREE.MeshBasicMaterial({
      color: side === "buy" ? BUY_COLOR : SELL_COLOR,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.scale.set(width * 0.32, width * 0.12, 1);
  glow.position.y = 0.04;
  group.add(glow);
  return group;
}

function createTank(material: THREE.SpriteMaterial, side: Side, scale = 1) {
  return createGroundedUnit(material, 6.1 * scale, 4.9 * scale, side);
}

function createAircraft(material: THREE.SpriteMaterial, bomber = false) {
  const group = new THREE.Group();
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(bomber ? 11.8 : 8.6, bomber ? 9.5 : 6.9, 1);
  sprite.renderOrder = 5;
  group.add(sprite);
  return group;
}

function createBase(side: Side) {
  const group = new THREE.Group();
  const color = side === "buy" ? 0x2fe99a : 0xef2b4e;
  const material = new THREE.MeshStandardMaterial({ color: side === "buy" ? 0x154936 : 0x4f1520, roughness: 0.68, metalness: 0.18 });
  const trim = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.38, roughness: 0.42 });
  const platform = new THREE.Mesh(new THREE.BoxGeometry(12, 0.65, 9), material);
  platform.position.y = 0.3;
  platform.receiveShadow = true;
  group.add(platform);
  for (const [x, z] of [[-4, -3], [4, -3], [-4, 3], [4, 3]] as Array<[number, number]>) {
    const tower = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.2, 2.2), material);
    tower.position.set(x, 1.9, z);
    tower.castShadow = true;
    group.add(tower);
    const beacon = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.18, 2.35), trim);
    beacon.position.set(x, 3.55, z);
    group.add(beacon);
  }
  const command = new THREE.Mesh(new THREE.BoxGeometry(5.4, 2.4, 4.2), material);
  command.position.y = 1.5;
  command.castShadow = true;
  group.add(command);
  const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 6, 7), trim);
  flagPole.position.set(0, 5.2, 0);
  group.add(flagPole);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.4), trim);
  flag.position.set(side === "buy" ? -1.45 : 1.45, 7.45, 0);
  flag.rotation.y = Math.PI / 2;
  group.add(flag);
  const light = new THREE.PointLight(color, 8, 22, 2);
  light.position.y = 6;
  group.add(light);
  return group;
}

export class BattlefieldScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 260);
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();
  private telemetry: BattlefieldTelemetry;
  private targetFront = 0;
  private front = 0;
  private targetBuyerShare = 0.5;
  private buyerShare = 0.5;
  private animationFrame = 0;
  private running = false;
  private width = 1;
  private height = 1;
  private readonly sellZone: THREE.Mesh;
  private readonly buyZone: THREE.Mesh;
  private readonly frontLine: THREE.Line;
  private readonly frontGlow: THREE.Line;
  private readonly tanks: TankUnit[] = [];
  private readonly aircraft: AircraftUnit[] = [];
  private readonly projectiles: ProjectileUnit[] = [];
  private readonly explosions: ExplosionUnit[] = [];
  private readonly buyerSoldiers: SoldierUnit[];
  private readonly sellerSoldiers: SoldierUnit[];
  private readonly priceLabels: THREE.Sprite[] = [];
  private lastRenderedPrice = Number.NaN;
  private userInteracting = false;
  private readonly onRenderError?: (message: string) => void;

  constructor(canvas: HTMLCanvasElement, telemetry: BattlefieldTelemetry, onRenderError?: (message: string) => void) {
    this.telemetry = telemetry;
    this.onRenderError = onRenderError;
    this.buyerShare = telemetry.buyerShare;
    this.targetBuyerShare = telemetry.buyerShare;
    this.front = this.frontForShare(telemetry.buyerShare);
    this.targetFront = this.front;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x040706, 1);

    this.scene.background = new THREE.Color(0x050807);
    this.scene.fog = new THREE.FogExp2(0x050807, 0.014);
    this.camera.position.set(0, 52, 58);
    this.camera.lookAt(0, 0, 0);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 105;
    this.controls.minPolarAngle = 0.32;
    this.controls.maxPolarAngle = 1.25;
    this.controls.maxAzimuthAngle = 0.92;
    this.controls.minAzimuthAngle = -0.92;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener("start", () => { this.userInteracting = true; });
    this.controls.addEventListener("end", () => { window.setTimeout(() => { this.userInteracting = false; }, 1600); });

    this.addLighting();
    this.addTerrain();
    const zoneGeometry = new THREE.PlaneGeometry(1, WORLD_DEPTH, 1, 1);
    zoneGeometry.rotateX(-Math.PI / 2);
    this.sellZone = new THREE.Mesh(zoneGeometry, new THREE.MeshBasicMaterial({ color: SELL_COLOR, transparent: true, opacity: 0.17, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.buyZone = new THREE.Mesh(zoneGeometry.clone(), new THREE.MeshBasicMaterial({ color: BUY_COLOR, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.sellZone.position.y = 0.38;
    this.buyZone.position.y = 0.39;
    this.scene.add(this.sellZone, this.buyZone);

    const frontPositions = new Float32Array(FRONT_SEGMENTS * 3);
    const frontGeometry = new THREE.BufferGeometry();
    frontGeometry.setAttribute("position", new THREE.BufferAttribute(frontPositions, 3));
    this.frontGlow = new THREE.Line(frontGeometry, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, linewidth: 1, blending: THREE.AdditiveBlending }));
    this.frontGlow.scale.set(1.018, 1.018, 1.018);
    this.frontLine = new THREE.Line(frontGeometry.clone(), new THREE.LineBasicMaterial({ color: BUY_COLOR, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending }));
    this.scene.add(this.frontGlow, this.frontLine);

    this.addRoads();
    this.addLakes();
    this.addVegetation();
    this.addBuildings();
    this.addBases();
    this.addTanks();
    this.buyerSoldiers = this.createSoldierArmy("buy");
    this.sellerSoldiers = this.createSoldierArmy("sell");
    this.addAircraft();
    this.addProjectiles();
    this.addExplosions();
    this.addPriceLadder();
    this.updateFrontGeometry(0);
    this.updateZones();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const animate = () => {
      if (!this.running) return;
      const delta = Math.min(this.clock.getDelta(), 0.05);
      const elapsed = this.clock.elapsedTime;
      try {
        this.render(delta, elapsed);
      } catch (error) {
        this.running = false;
        this.onRenderError?.(error instanceof Error ? error.message : "The 3D renderer stopped unexpectedly.");
        return;
      }
      this.animationFrame = window.requestAnimationFrame(animate);
    };
    this.animationFrame = window.requestAnimationFrame(animate);
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
  }

  setTelemetry(telemetry: BattlefieldTelemetry) {
    this.telemetry = telemetry;
    this.targetBuyerShare = telemetry.buyerShare;
    this.targetFront = this.frontForShare(telemetry.buyerShare);
  }

  recenter() {
    this.camera.position.set(0, 52, 58);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  dispose() {
    this.running = false;
    window.cancelAnimationFrame(this.animationFrame);
    this.controls.dispose();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Sprite || object instanceof THREE.InstancedMesh) {
        object.geometry?.dispose();
        if (object.material) disposeMaterial(object.material);
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private frontForShare(share: number) {
    return THREE.MathUtils.lerp(22, -22, clamp(share, 0.04, 0.96));
  }

  private addLighting() {
    const hemisphere = new THREE.HemisphereLight(0xb9d8d0, 0x1d1712, 2.1);
    this.scene.add(hemisphere);
    const moon = new THREE.DirectionalLight(0xe8f4ef, 4.2);
    moon.position.set(-26, 46, 22);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.left = -64;
    moon.shadow.camera.right = 64;
    moon.shadow.camera.top = 48;
    moon.shadow.camera.bottom = -48;
    moon.shadow.bias = -0.0002;
    this.scene.add(moon);
    const redRim = new THREE.DirectionalLight(SELL_COLOR, 2.1);
    redRim.position.set(-48, 18, -16);
    this.scene.add(redRim);
    const greenRim = new THREE.DirectionalLight(BUY_COLOR, 2.1);
    greenRim.position.set(48, 18, 12);
    this.scene.add(greenRim);
  }

  private addTerrain() {
    const geometry = new THREE.PlaneGeometry(WORLD_WIDTH, WORLD_DEPTH, 84, 52);
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const colors: number[] = [];
    for (let index = 0; index < position.count; index += 1) {
      const x = position.getX(index);
      const z = position.getY(index);
      const height = terrainHeight(x, z);
      position.setZ(index, height);
      const shade = clamp(0.34 + height * 0.035 + seeded(index) * 0.07, 0.25, 0.52);
      tempColor.setHSL(0.25 + seeded(index + 40) * 0.035, 0.38, shade);
      colors.push(tempColor.r, tempColor.g, tempColor.b);
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    geometry.rotateX(-Math.PI / 2);
    const terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.02 }));
    terrain.receiveShadow = true;
    this.scene.add(terrain);

    const grid = new THREE.GridHelper(WORLD_WIDTH, 28, 0x55645e, 0x314139);
    grid.position.y = 0.25;
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    gridMaterials.forEach((material) => { material.transparent = true; material.opacity = 0.13; material.depthWrite = false; });
    this.scene.add(grid);
  }

  private addRoads() {
    const points: THREE.Vector3[] = [];
    for (let index = 0; index <= 48; index += 1) {
      const x = -58 + (116 * index) / 48;
      const z = 9 + Math.sin(x * 0.075) * 4.2 + Math.sin(x * 0.19) * 1.1;
      points.push(new THREE.Vector3(x, terrainHeight(x, z) + 0.48, z));
    }
    const road = new THREE.Mesh(ribbonGeometry(points, 5.1), new THREE.MeshStandardMaterial({ color: 0x171b1b, roughness: 0.84, metalness: 0.08 }));
    road.receiveShadow = true;
    this.scene.add(road);
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xd9cfaa, transparent: true, opacity: 0.46 });
    const center = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map((point) => point.clone().add(new THREE.Vector3(0, 0.12, 0)))), new THREE.LineDashedMaterial({ color: 0xe7dba8, dashSize: 1.4, gapSize: 1.1, transparent: true, opacity: 0.44 }));
    center.computeLineDistances();
    this.scene.add(center);
    for (const offset of [-2.55, 2.55]) {
      const edgePoints = points.map((point, index) => {
        const previous = points[Math.max(0, index - 1)];
        const next = points[Math.min(points.length - 1, index + 1)];
        const tangent = next.clone().sub(previous).normalize();
        return point.clone().add(new THREE.Vector3(-tangent.z, 0.14, tangent.x).multiplyScalar(offset));
      });
      this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(edgePoints), edgeMaterial));
    }
  }

  private addLakes() {
    for (const [x, z, sx, sz] of [[35, -23, 1.3, 0.72], [-37, 25, 1.15, 0.62]] as Array<[number, number, number, number]>) {
      const lake = new THREE.Mesh(new THREE.CircleGeometry(7, 48), new THREE.MeshPhysicalMaterial({ color: 0x06394d, roughness: 0.18, metalness: 0.08, transmission: 0.08, transparent: true, opacity: 0.9 }));
      lake.rotation.x = -Math.PI / 2;
      lake.scale.set(sx, sz, 1);
      lake.position.set(x, terrainHeight(x, z) + 0.38, z);
      this.scene.add(lake);
      const ring = new THREE.Mesh(new THREE.RingGeometry(7.1, 7.6, 48), new THREE.MeshBasicMaterial({ color: 0x9baf8e, transparent: true, opacity: 0.42, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.scale.copy(lake.scale);
      ring.position.copy(lake.position).add(new THREE.Vector3(0, 0.01, 0));
      this.scene.add(ring);
    }
  }

  private addVegetation() {
    const treeGeometry = new THREE.ConeGeometry(0.32, 1.8, 7);
    const treeMaterial = new THREE.MeshStandardMaterial({ color: 0x173f27, roughness: 0.96 });
    const trees = new THREE.InstancedMesh(treeGeometry, treeMaterial, 310);
    trees.castShadow = true;
    trees.receiveShadow = true;
    for (let index = 0; index < 310; index += 1) {
      let x = seeded(index + 3) * 106 - 53;
      let z = seeded(index + 700) * 64 - 32;
      if (Math.abs(x) < 10) x += x < 0 ? -9 : 9;
      if (Math.abs(z - (9 + Math.sin(x * 0.075) * 4.2)) < 5) z += z < 8 ? -7 : 7;
      const scale = 0.72 + seeded(index + 1500) * 1.05;
      tempObject.position.set(x, terrainHeight(x, z) + 0.88 * scale, z);
      tempObject.rotation.y = seeded(index + 3100) * Math.PI * 2;
      tempObject.scale.set(scale, scale, scale);
      tempObject.updateMatrix();
      trees.setMatrixAt(index, tempObject.matrix);
      tempColor.setHSL(0.31 + seeded(index + 8000) * 0.05, 0.46, 0.18 + seeded(index + 9000) * 0.07);
      trees.setColorAt(index, tempColor);
    }
    trees.instanceMatrix.needsUpdate = true;
    if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
    this.scene.add(trees);
  }

  private addBuildings() {
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x7d745f, roughness: 0.93 });
    const roofMaterial = new THREE.MeshStandardMaterial({ color: 0x472a23, roughness: 0.84 });
    for (let index = 0; index < 16; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const x = side * (25 + seeded(index + 20) * 22);
      const z = -26 + seeded(index + 380) * 52;
      const group = new THREE.Group();
      const house = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.8, 2.1), wallMaterial);
      house.position.y = 0.9;
      house.castShadow = true;
      group.add(house);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.75, 1.25, 4), roofMaterial);
      roof.position.y = 2.42;
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      group.add(roof);
      group.position.set(x, terrainHeight(x, z), z);
      group.rotation.y = seeded(index + 990) * Math.PI;
      group.scale.setScalar(0.72 + seeded(index + 1260) * 0.48);
      this.scene.add(group);
    }
  }

  private addBases() {
    const sellerBase = createBase("sell");
    sellerBase.position.set(-47, terrainHeight(-47, -19), -19);
    sellerBase.scale.setScalar(0.78);
    this.scene.add(sellerBase);
    const buyerBase = createBase("buy");
    buyerBase.position.set(47, terrainHeight(47, -19), -19);
    buyerBase.scale.setScalar(0.78);
    this.scene.add(buyerBase);
  }

  private addTanks() {
    for (const side of ["sell", "buy"] as Side[]) {
      const material = createUnitMaterial(tankUnitUrl, side);
      for (let index = 0; index < 14; index += 1) {
        const group = createTank(material, side, 0.72 + seeded(index + (side === "buy" ? 300 : 0)) * 0.2);
        this.scene.add(group);
        this.tanks.push({
          group,
          side,
          phase: seeded(index + (side === "buy" ? 500 : 100)),
          speed: 0.0055 + seeded(index + 1300) * 0.0045,
          lane: -26 + ((index * 11 + (side === "buy" ? 5 : 0)) % 53),
          index
        });
      }
    }
  }

  private createSoldierArmy(side: Side) {
    const capacity = 72;
    const material = createUnitMaterial(soldierUnitUrl, side);
    const units: SoldierUnit[] = [];
    for (let index = 0; index < capacity; index += 1) {
      const sprite = new THREE.Sprite(material);
      const size = 1.35 + seeded(index + (side === "buy" ? 2300 : 1800)) * 0.42;
      sprite.scale.set(size, size, 1);
      sprite.renderOrder = 3;
      this.scene.add(sprite);
      units.push({
        sprite,
        side,
        phase: seeded(index + (side === "buy" ? 900 : 200)),
        speed: 0.0065 + seeded(index + 4200) * 0.005,
        lane: -31 + seeded(index + (side === "buy" ? 5200 : 4700)) * 62,
        rank: 0.85 + (index % 9) * 0.68 + seeded(index + 6100) * 0.35,
        size,
        index
      });
    }
    return units;
  }

  private addAircraft() {
    const materials = {
      buy: createUnitMaterial(aircraftUnitUrl, "buy"),
      sell: createUnitMaterial(aircraftUnitUrl, "sell")
    };
    for (let index = 0; index < 5; index += 1) {
      const side: Side = index % 2 === 0 ? "buy" : "sell";
      const group = createAircraft(materials[side], false);
      group.scale.setScalar(0.8 + seeded(index + 20) * 0.18);
      this.scene.add(group);
      this.aircraft.push({ group, side, phase: seeded(index + 44), speed: 0.009 + seeded(index + 210) * 0.005, altitude: 9 + seeded(index + 70) * 5, lane: -24 + seeded(index + 430) * 48 });
    }
    for (let index = 0; index < 2; index += 1) {
      const side: Side = index === 0 ? "sell" : "buy";
      const group = createAircraft(materials[side], true);
      group.scale.setScalar(0.82);
      this.scene.add(group);
      this.aircraft.push({ group, side, phase: seeded(index + 700), speed: 0.0045 + index * 0.0012, altitude: 14 + index * 2, lane: -10 + index * 20, bomber: true });
    }
  }

  private addProjectiles() {
    for (let index = 0; index < 26; index += 1) {
      const side: Side = index % 2 === 0 ? "buy" : "sell";
      const color = side === "buy" ? 0x65ffc3 : 0xff4b68;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.1 + seeded(index) * 0.08, 6, 5), new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending }));
      this.scene.add(mesh);
      this.projectiles.push({ mesh, side, phase: seeded(index + 99), speed: 0.12 + seeded(index + 404) * 0.12, lane: -29 + seeded(index + 808) * 58 });
    }
  }

  private addExplosions() {
    for (let index = 0; index < 14; index += 1) {
      const side: Side = index % 2 === 0 ? "buy" : "sell";
      const group = new THREE.Group();
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 9), new THREE.MeshBasicMaterial({ color: 0xffb339, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
      const shell = new THREE.Mesh(new THREE.SphereGeometry(1.25, 12, 9), new THREE.MeshBasicMaterial({ color: side === "buy" ? BUY_COLOR : SELL_COLOR, wireframe: true, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.05, 24), new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.72, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      group.add(core, shell, ring);
      group.visible = false;
      this.scene.add(group);
      this.explosions.push({ group, phase: seeded(index + 190), speed: 0.045 + seeded(index + 720) * 0.035, lane: -27 + seeded(index + 920) * 54, side });
    }
  }

  private addPriceLadder() {
    for (let index = 0; index < 9; index += 1) {
      const material = new THREE.SpriteMaterial({ map: makeLabelTexture("--", index === 4 ? "#ffffff" : "#a9b3af", index === 4), transparent: true, depthWrite: false, opacity: index === 4 ? 0.96 : 0.6 });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(index === 4 ? 7.8 : 6.2, index === 4 ? 1.7 : 1.3, 1);
      sprite.position.z = -28 + index * 7;
      this.priceLabels.push(sprite);
      this.scene.add(sprite);
    }
  }

  private render(delta: number, elapsed: number) {
    const frontSmoothing = 1 - Math.exp(-delta / 8.5);
    const strengthSmoothing = 1 - Math.exp(-delta / 5.5);
    this.front += (this.targetFront - this.front) * frontSmoothing;
    this.buyerShare += (this.targetBuyerShare - this.buyerShare) * strengthSmoothing;
    this.updateZones();
    this.updateFrontGeometry(elapsed);
    this.updateTanks(elapsed);
    this.updateSoldiers(elapsed);
    this.updateAircraft(elapsed);
    this.updateProjectiles(elapsed);
    this.updateExplosions(elapsed);
    this.updatePriceLadder();
    if (!this.userInteracting) {
      this.controls.target.x += ((this.front * 0.08) - this.controls.target.x) * 0.008;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private updateZones() {
    const sellerWidth = Math.max(1, this.front + WORLD_WIDTH / 2);
    const buyerWidth = Math.max(1, WORLD_WIDTH / 2 - this.front);
    this.sellZone.scale.x = sellerWidth;
    this.sellZone.position.x = -WORLD_WIDTH / 2 + sellerWidth / 2;
    this.buyZone.scale.x = buyerWidth;
    this.buyZone.position.x = this.front + buyerWidth / 2;
    const buyMaterial = this.buyZone.material as THREE.MeshBasicMaterial;
    const sellMaterial = this.sellZone.material as THREE.MeshBasicMaterial;
    buyMaterial.opacity = 0.09 + this.buyerShare * 0.14;
    sellMaterial.opacity = 0.09 + (1 - this.buyerShare) * 0.14;
  }

  private updateFrontGeometry(elapsed: number) {
    const write = (line: THREE.Line, glow = false) => {
      const position = line.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let index = 0; index < FRONT_SEGMENTS; index += 1) {
        const progress = index / (FRONT_SEGMENTS - 1);
        const z = -WORLD_DEPTH / 2 + progress * WORLD_DEPTH;
        const waviness = Math.sin(z * 0.23 + elapsed * 0.34) * 0.55 + Math.sin(z * 0.09 - elapsed * 0.21) * 0.38;
        const x = this.front + waviness;
        position.setXYZ(index, x, terrainHeight(x, z) + (glow ? 0.66 : 0.72), z);
      }
      position.needsUpdate = true;
    };
    write(this.frontLine);
    write(this.frontGlow, true);
    const color = this.buyerShare >= 0.5 ? BUY_COLOR : SELL_COLOR;
    (this.frontLine.material as THREE.LineBasicMaterial).color.lerp(color, 0.08);
    (this.frontGlow.material as THREE.LineBasicMaterial).color.copy(color);
    (this.frontGlow.material as THREE.LineBasicMaterial).opacity = 0.12 + Math.sin(elapsed * 4.5) * 0.05;
  }

  private updateTanks(elapsed: number) {
    const buyerVisible = Math.round(5 + this.buyerShare * 9);
    const sellerVisible = Math.round(5 + (1 - this.buyerShare) * 9);
    for (const unit of this.tanks) {
      unit.group.visible = unit.index < (unit.side === "buy" ? buyerVisible : sellerVisible);
      if (!unit.group.visible) continue;
      const phase = (unit.phase + elapsed * unit.speed) % 1;
      const march = clamp(phase / 0.7, 0, 1);
      const easedMarch = march * march * (3 - 2 * march);
      const laneWave = Math.sin(elapsed * 0.11 + unit.index) * 0.55;
      let x: number;
      if (unit.side === "sell") {
        const span = Math.max(8, this.front + 49);
        x = -49 + span * (0.12 + easedMarch * 0.84);
        x = Math.min(x, this.front - 1.8);
      } else {
        const span = Math.max(8, 49 - this.front);
        x = 49 - span * (0.12 + easedMarch * 0.84);
        x = Math.max(x, this.front + 1.8);
      }
      const z = clamp(unit.lane + laneWave, -31, 31);
      unit.group.position.set(x, terrainHeight(x, z) + 0.12 + Math.sin(elapsed * 1.1 + unit.index) * 0.025, z);
    }
  }

  private updateSoldiers(elapsed: number) {
    this.updateSoldierSide("buy", this.buyerSoldiers, Math.round(18 + this.buyerShare * 54), elapsed);
    this.updateSoldierSide("sell", this.sellerSoldiers, Math.round(18 + (1 - this.buyerShare) * 54), elapsed);
  }

  private updateSoldierSide(side: Side, units: SoldierUnit[], visibleCount: number, elapsed: number) {
    for (const unit of units) {
      unit.sprite.visible = unit.index < visibleCount;
      if (!unit.sprite.visible) continue;
      const phase = (unit.phase + elapsed * unit.speed) % 1;
      const march = clamp(phase / 0.66, 0, 1);
      const easedMarch = march * march * (3 - 2 * march);
      const startX = side === "buy"
        ? 45 - seeded(unit.index + 7300) * 9
        : -45 + seeded(unit.index + 7300) * 9;
      const frontX = this.front + (side === "buy" ? unit.rank : -unit.rank);
      const combatDrift = phase >= 0.66 ? Math.sin(elapsed * 0.55 + unit.index) * 0.3 : 0;
      const x = THREE.MathUtils.lerp(startX, frontX, easedMarch) + combatDrift;
      const lane = clamp(unit.lane + Math.sin(elapsed * 0.18 + unit.index * 1.7) * 0.28, -31, 31);
      const step = Math.abs(Math.sin(elapsed * 2.1 + unit.index)) * 0.035;
      unit.sprite.position.set(x, terrainHeight(x, lane) + 0.72 + step, lane);
      unit.sprite.scale.set(unit.size, unit.size, 1);
    }
  }

  private updateAircraft(elapsed: number) {
    for (const aircraft of this.aircraft) {
      const phase = (aircraft.phase + elapsed * aircraft.speed) % 1;
      const x = aircraft.side === "sell" ? -68 + phase * 136 : 68 - phase * 136;
      const z = aircraft.lane + Math.sin(elapsed * 0.35 + aircraft.phase * 8) * (aircraft.bomber ? 3 : 6);
      aircraft.group.position.set(x, aircraft.altitude + Math.sin(elapsed + aircraft.phase * 4) * 0.45, z);
      aircraft.group.rotation.z = Math.sin(elapsed * 0.8 + aircraft.phase * 6) * 0.08;
    }
  }

  private updateProjectiles(elapsed: number) {
    const intensity = 0.72 + Math.abs(this.buyerShare - 0.5) * 1.3;
    for (const projectile of this.projectiles) {
      const phase = (projectile.phase + elapsed * projectile.speed * intensity) % 1;
      const fromX = this.front + (projectile.side === "buy" ? 7 : -7);
      const toX = this.front + (projectile.side === "buy" ? -5 : 5);
      const x = THREE.MathUtils.lerp(fromX, toX, phase);
      const z = projectile.lane + Math.sin(elapsed * 0.7 + projectile.phase * 9) * 1.1;
      const y = terrainHeight(x, z) + 0.8 + Math.sin(phase * Math.PI) * 3.8;
      projectile.mesh.position.set(x, y, z);
      projectile.mesh.scale.setScalar(0.7 + Math.sin(phase * Math.PI) * 1.5);
    }
  }

  private updateExplosions(elapsed: number) {
    const intensity = 0.8 + Math.abs(this.buyerShare - 0.5) * 1.4;
    for (const explosion of this.explosions) {
      const phase = (explosion.phase + elapsed * explosion.speed * intensity) % 1;
      const active = phase < 0.12;
      explosion.group.visible = active;
      if (!active) continue;
      const normalized = phase / 0.12;
      const x = this.front + (explosion.side === "buy" ? -1 : 1) * (1.5 + seeded(explosion.phase * 100) * 4.5);
      const z = explosion.lane;
      explosion.group.position.set(x, terrainHeight(x, z) + 0.65, z);
      const scale = Math.sin(normalized * Math.PI) * (1.1 + seeded(explosion.phase * 300) * 1.7);
      explosion.group.scale.set(scale, scale * 0.78, scale);
      explosion.group.rotation.y = normalized * 1.7;
      for (const child of explosion.group.children) {
        const material = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
        if (material) material.opacity = (1 - normalized) * 0.9;
      }
    }
  }

  private updatePriceLadder() {
    const price = this.telemetry.price;
    if (!Number.isFinite(price)) return;
    if (Math.abs(price - this.lastRenderedPrice) > Math.max(0.05, price * 0.000002)) {
      this.lastRenderedPrice = price;
      this.priceLabels.forEach((sprite, index) => {
        const offset = index - 4;
        const labelPrice = price * (1 + offset * 0.00072);
        const material = sprite.material as THREE.SpriteMaterial;
        material.map?.dispose();
        material.map = makeLabelTexture(labelPrice.toLocaleString(undefined, { maximumFractionDigits: 1 }), index === 4 ? "#ffffff" : "#a8b2ae", index === 4);
        material.needsUpdate = true;
      });
    }
    this.priceLabels.forEach((sprite, index) => {
      const z = -28 + index * 7;
      const wave = Math.sin(z * 0.23 + this.clock.elapsedTime * 0.34) * 0.55 + Math.sin(z * 0.09 - this.clock.elapsedTime * 0.21) * 0.38;
      const x = this.front + wave;
      sprite.position.set(x + (index % 2 === 0 ? -2.7 : 2.7), terrainHeight(x, z) + 1.35, z);
    });
  }
}
