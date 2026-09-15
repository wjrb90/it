class XR8Controller {

    constructor(canvas, threePlayer, debug = false) {
        this.canvas = canvas;
        this.threePlayer = threePlayer;
        this.debug = debug;
        this.targets = [];
        this.started = false;
        this.isMobile = /Android|iPhone|iPod|iPad/i.test(navigator.userAgent);

        // Do not enable 6DoF/world tracking: the content must be anchored ONLY to the
        // active image target, so the general scene never syncs to camera motion.
        this.disableWorldTracking = true;

        // Copy the AR camera pose to the player camera too (off by default: the general
        // scene stays fixed and only the active target is synced).
        this.syncSceneToCamera = false;

        // Per-target anchors: Map<targetName, { group: THREE.Group, wrapper: THREE.Group }>
        this.targetAnchors = new Map();

        this.listeners = {
            start: [],
            found: [],
            updated: [],
            lost: [],
            update: [],
        };

        this.ready = null;

        // Click / pointer handling for AR
        this.clickHandlerBound = false;
    }

    // In AR mode the visible content is reparented into XR8's own Three scene and
    // rendered with XR8's camera, so the APP.Player raycast (which uses its own
    // camera/scene) never hits it. We re-implement click-to-activate using the real
    // XR8 scene and camera instead.
    bindClickEvents() {
        if (this.clickHandlerBound) return;
        this.clickHandlerBound = true;

        if (window.PointerEvent) {
            document.addEventListener('pointerdown', (ev) => this.onArClick(ev));
        } else {
            document.addEventListener('touchstart', (ev) => {
                const touch = ev.changedTouches?.[0];
                if (touch) this.onArClick(touch);
            });
            document.addEventListener('click', (ev) => this.onArClick(ev));
        }
    }

    onArClick(ev) {
        const xr8 = window.XR8;
        if (!xr8?.Threejs?.xrScene) return;

        const { camera, scene } = xr8.Threejs.xrScene();
        if (!camera || !scene || !this.canvas) return;

        const rect = this.canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((ev.clientX - rect.left) / rect.width) * 2 - 1,
            -((ev.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, camera);

        const hits = raycaster.intersectObjects(scene.children, true);
        for (const hit of hits) {
            let obj = hit.object;
            while (obj) {
                if (obj.onClick && typeof obj.onClick === 'function' && this.objIsActive(obj)) {
                    obj.onClick();
                    return;
                }
                obj = obj.parent;
            }
        }
    }

    objIsActive(obj) {
        if (obj.visible === false) return false;
        let active = true;
        obj.traverseAncestors((ancestor) => {
            if (ancestor.visible === false) { active = false; }
        });
        return active;
    }

    addListener(type, callback) { this.listeners[type].push(callback); }

    waitForReady() {

        if (this.ready) return this.ready;

        this.ready = new Promise((resolve, reject) => {

            if (window.XR8) return resolve(window.XR8);

            let settled = false;

            const onReady = () => {
                if (settled) return;
                settled = true;
                window.removeEventListener('xrloaded', onReady);
                resolve(window.XR8);
            };

            window.addEventListener('xrloaded', onReady);

            const interval = setInterval(() => {
                if (window.XR8) {
                    clearInterval(interval);
                    onReady();
                }
            }, 100);

            setTimeout(() => {
                if (settled) return;
                settled = true;
                clearInterval(interval);
                window.removeEventListener('xrloaded', onReady);
                reject(new Error("Tiempo de espera agotado esperando a XR8."));
            }, 30000);
        });

        return this.ready;
    }

    // Read player.imageTargets (populated by the editor scripts) and build XR8 target data
    // from each ImageTarget's texture. Each target gets a unique name (target_0, target_1…)
    // so XR8 can distinguish them in reality.imagefound/imageupdated/imagelost events.
    async setImageTargetsFromPlayer() {
        const imageTargets = this.threePlayer?.imageTargets;
        if (!imageTargets || !imageTargets.length) {
            throw new Error("player.imageTargets está vacío. Asegurate de que los scripts de la escena se ejecutaron.");
        }

        const targets = [];

        for (let i = 0; i < imageTargets.length; i++) {
            const it = imageTargets[i];
            const texture = it.target;
            if (!texture || !texture.image) {
                console.warn(`ImageTarget [${i}] sin textura válida, saltando:`, it);
                continue;
            }

            const name = `target_${i}`;
            const target = await this.targetFromTexture(texture, name);
            targets.push(target);

            // Store the mapping name → ImageTarget object for anchor creation in onStart
            it._targetName = name;
        }

        if (!targets.length) {
            throw new Error("Ningún ImageTarget de la escena tenía textura válida.");
        }

        this.targets = targets;
        return targets;
    }

    // Build an XR8 image target descriptor (in the same shape as a published nadd0.json)
    // from a THREE.Texture. `properties` with originalWidth/originalHeight is required by
    // the tracker, otherwise it crashes reading them as undefined.
    async targetFromTexture(texture, name) {
        const { dataUrl, width, height } = await this.textureToDataUrl(texture);

        return {
            name,
            type: 'PLANAR',
            imagePath: dataUrl,
            properties: {
                top: 0,
                left: 0,
                width,
                height,
                isRotated: false,
                originalWidth: width,
                originalHeight: height,
            },
            metadata: null,
            resources: { originalImage: dataUrl },
        };
    }

    async textureToDataUrl(texture) {
        const source = texture.image;

        if (typeof source.decode === 'function') {
            try { await source.decode(); } catch (e) { /* ignore */ }
        } else if (source instanceof HTMLImageElement && !source.complete) {
            await new Promise((resolve) => {
                source.addEventListener('load', resolve, { once: true });
                source.addEventListener('error', resolve, { once: true });
            });
        }

        const width = source.naturalWidth || source.width;
        const height = source.naturalHeight || source.height;

        if (!width || !height) {
            throw new Error("La textura no tiene dimensiones válidas.");
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

        return { dataUrl, width, height };
    }

    async start() {

        if (this.started) return;

        await this.waitForReady();

        if (!this.targets || !this.targets.length) {
            throw new Error("No hay Image Targets cargados.");
        }

        this.ensureCanvasFullscreen();

        this.bindClickEvents();

        XR8.XrController.configure({
            imageTargetData: this.targets,
            disableWorldTracking: this.disableWorldTracking,
        });

        XR8.addCameraPipelineModules([
            XR8.XrController.pipelineModule(),
            XR8.GlTextureRenderer.pipelineModule(),
            XR8.Threejs.pipelineModule(),

            this.createDebugPipeline(),
            this.createUpdatePipeline(),
            this.createThreePipeline(),
            this.createImageTargetPipeline(),
        ]);

        console.log("XR8Controller: pipeline modules added");

        const allowedDevices = XR8.XrConfig.device().ANY;

        XR8.run({
            canvas: this.canvas,
            allowedDevices,
            cameraConfig: {
                direction: this.isMobile
                    ? XR8.XrConfig.camera().BACK
                    : XR8.XrConfig.camera().FRONT,
            },
        });

        this.ensureCanvasFullscreen();

        this.started = true;
    }

    ensureCanvasFullscreen() {
        if (!this.canvas) return;

        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';

        if (this.canvas.parentElement) {
            this.canvas.parentElement.style.width = '100%';
            this.canvas.parentElement.style.height = '100%';
        }
    }

    createDebugPipeline() {

        return {

            name: "debug",

            onStart: () => {
                console.log("Pipeline iniciado");
                this.dispatch('start');
            },

            onProcessCpu: () => {
            }

        };
    }

    createThreePipeline() {
        return {

            name: 'myawesomeapp',

            onStart: ({ canvasWidth, canvasHeight }) => {
                this.ensureCanvasFullscreen();

                if (this.threePlayer?.setRenderEnabled) {
                    this.threePlayer.setRenderEnabled(false);
                }

                console.log('XR8THREE', XR8.Threejs);
                const { scene, camera, renderer } = XR8.Threejs.xrScene()

                const appScene = this.threePlayer?.scene;
                const appRenderer = this.threePlayer?.renderer;

                if (appScene) {
                    if (appScene.environment) {
                        scene.environment = appScene.environment;
                    }
                    if (appScene.environmentIntensity !== undefined) {
                        scene.environmentIntensity = appScene.environmentIntensity;
                    }
                    if (appScene.environmentRotation) {
                        scene.environmentRotation.copy(appScene.environmentRotation);
                    }
                }

                if (appRenderer && renderer) {
                    renderer.toneMapping = appRenderer.toneMapping;
                    renderer.toneMappingExposure = appRenderer.toneMappingExposure;
                    renderer.outputColorSpace = appRenderer.outputColorSpace || renderer.outputColorSpace;
                    renderer.shadowMap.enabled = appRenderer.shadowMap.enabled && !this.isMobile;
                    renderer.shadowMap.type = appRenderer.shadowMap.type;
                }

                // if (renderer && this.canvas) {
                //     const bufferScale = 0.95;
                //     const w = Math.floor(this.canvas.clientWidth * bufferScale);
                //     const h = Math.floor(this.canvas.clientHeight * bufferScale);
                //     renderer.setSize(w, h, false);
                // }

                camera.near = 0.01;
                camera.far = 100;
                camera.updateProjectionMatrix();

                // Create a per-target anchor for each ImageTarget. Each anchor holds only
                // that target's ARContent, positioned independently when the target is found.
                const imageTargets = this.threePlayer?.imageTargets || [];
                for (const it of imageTargets) {
                    const name = it._targetName;
                    if (!name || !it.arContent) continue;

                    if (it.gizmo) it.gizmo.visible = this.debug;
                    if (it.arContent) it.arContent.visible = false;


                    const wrapper = new THREE.Group();
                    wrapper.rotation.set(THREE.MathUtils.degToRad(90), 0, 0);
                    // wrapper.scale.setScalar(0.3);

                    // Reparent the whole ImageTarget group (gizmo + arContent) so both
                    // share the same XR8 target pose and are visually centered together.
                    wrapper.add(it.obj);
                    it.obj.position.set(0, 0, 0);
                    it.obj.rotation.set(THREE.MathUtils.degToRad(90), THREE.MathUtils.degToRad(-90), 0);
                    it.obj.scale.setScalar(0.6);

                    scene.add(wrapper);

                    this.targetAnchors.set(name, { wrapper, it });

                    if (this.debug) {
                        this.addMarkerDebugHelpers(wrapper);
                    }
                }

                // Add lights from the player scene so AR content is lit correctly.
                const lights = [];
                appScene?.traverse?.((obj) => {
                    if (obj.isLight && obj !== appScene) {
                        lights.push(obj.clone());
                    }
                });
                for (const light of lights) {
                    scene.add(light);
                }

                XR8.XrController.updateCameraProjectionMatrix({
                    origin: camera.position,
                    facing: camera.quaternion,
                })

            },

            onUpdate: () => {
                const arCam = XR8.Threejs.xrScene?.()?.camera;
                const appCamera = this.threePlayer?.camera;
                if (arCam && appCamera) {
                    if (this.syncSceneToCamera) {
                        appCamera.position.copy(arCam.position);
                        appCamera.quaternion.copy(arCam.quaternion);
                    }
                    appCamera.projectionMatrix.copy(arCam.projectionMatrix);
                    appCamera.projectionMatrixInverse.copy(arCam.projectionMatrixInverse);
                    if (appCamera.isPerspectiveCamera) {
                        appCamera.fov = arCam.fov;
                        appCamera.aspect = arCam.aspect;
                        appCamera.near = arCam.near;
                        appCamera.far = arCam.far;
                    }
                }
            },

        };

    }

    createImageTargetPipeline() {
        return {
            name: "image-target",
            listeners: [
                {
                    event: "reality.imagefound",
                    process: (e) => this.onImageFound(e),
                },

                {
                    event: "reality.imageupdated",
                    process: (e) => this.onImageUpdated(e),
                },

                {
                    event: "reality.imagelost",
                    process: (e) => this.onImageLost(e),
                }

            ]

        };

    }

    createUpdatePipeline() {
        return {
            name: "update",
            onUpdate: () => {
                this.dispatch('update');
            }
        };
    }

    dispatch(type, event) {
        for (const listener of this.listeners[type]) {
            listener(event);
        }
    }

    onImageFound(e) {
        const detail = e?.detail || {};
        const name = detail.name;
        console.log(`XR8Controller: target detectado "${name}"`, e);
        this.syncAnchorToTarget(name, detail);

        const anchor = this.targetAnchors.get(name);
        if (anchor?.it?.onFound) anchor.it.onFound.call(anchor.it);
        if (anchor?.it?.arContent) anchor.it.arContent.visible = true;

        this.dispatch('found', e);
    }

    onImageUpdated(e) {
        const detail = e?.detail || {};
        const name = detail.name;
        this.syncAnchorToTarget(name, detail);
        this.dispatch('updated', e);
    }

    onImageLost(e) {
        const detail = e?.detail || {};
        const name = detail.name;
        console.log(`XR8Controller: target perdido "${name}"`, e);

        const anchor = this.targetAnchors.get(name);
        if (anchor) {
            anchor.wrapper.visible = false;
            if (anchor?.it?.arContent) anchor.it.arContent.visible = false;
            if (anchor.it?.onLost) anchor.it.onLost.call(anchor.it);
        }

        this.dispatch('lost', e);
    }

    syncAnchorToTarget(name, detail) {
        const anchor = this.targetAnchors.get(name);
        if (!anchor) return;

        const position = detail.position || detail.worldPosition;
        const rotation = detail.rotation || detail.worldRotation || detail.quaternion;
        const scale = detail.scale;

        if (position) {
            anchor.wrapper.position.set(position.x, position.y, position.z);
        }

        if (rotation) {
            if (rotation.w !== undefined) {
                anchor.wrapper.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
            } else {
                anchor.wrapper.rotation.set(rotation.x, rotation.y, rotation.z);
            }
        }

        if (scale) {
            if (typeof scale === 'number') {
                anchor.wrapper.scale.setScalar(scale);
            } else {
                anchor.wrapper.scale.set(scale.x, scale.y, scale.z);
            }
        }

        anchor.wrapper.visible = true;
    }

    addMarkerDebugHelpers(root) {
        const planeSize = 0.3;
        const planeGeometry = new THREE.PlaneGeometry(planeSize, planeSize, 1, 1);
        const planeMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            transparent: true,
            opacity: 0.25,
            side: THREE.DoubleSide,
            depthWrite: false,
        });

        const markerPlane = new THREE.Mesh(planeGeometry, planeMaterial);
        root.add(markerPlane);

        const markerEdges = new THREE.LineSegments(
            new THREE.EdgesGeometry(planeGeometry),
            new THREE.LineBasicMaterial({ color: 0x00ffff })
        );
        root.add(markerEdges);

        const axes = new THREE.AxesHelper(0.2);
        root.add(axes);
    }

}

export { XR8Controller };
