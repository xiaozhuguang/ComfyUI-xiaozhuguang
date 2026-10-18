import { computeTrackballRotation, TRACKBALL_ROTATION_GAIN } from '../vnccs_pose_vendor/three/trackball_rotation.mjs?v=20261017.sensitivity1';

/**
 * VNCCS Pose Studio Core
 * 
 * Extracted reusable 3D viewer logic.
 */


// Determine the extension's base URL dynamically to support varied directory names
const EXTENSION_URL = new URL(".", import.meta.url).toString();
export const POSE_STUDIO_CAPTURE_FOV = 30;

// User-facing CAD convention mapped onto Three.js's Y-up scene coordinates.
const POSE_STUDIO_EDITOR_AXES = Object.freeze({
    X: Object.freeze([1, 0, 0]),
    Y: Object.freeze([0, 0, 1]),
    Z: Object.freeze([0, 1, 0]),
});

function editorAxisVector(THREE, axis, sign = 1) {
    const coordinates = POSE_STUDIO_EDITOR_AXES[axis];
    return new THREE.Vector3(...coordinates).multiplyScalar(sign);
}

export function computeEquivalentPerspectiveZoom(sourceFov, targetFov = POSE_STUDIO_CAPTURE_FOV) {
    const source = Number(sourceFov);
    const target = Number(targetFov);
    if (
        !Number.isFinite(source)
        || !Number.isFinite(target)
        || source <= 0
        || source >= 179
        || target <= 0
        || target >= 179
    ) return null;
    return Math.tan((target * Math.PI / 180) * 0.5)
        / Math.tan((source * Math.PI / 180) * 0.5);
}

export function buildEquivalentPerspectiveProjectionFrame(
    sourceFrame,
    targetFov = POSE_STUDIO_CAPTURE_FOV,
) {
    if (!sourceFrame?.cameraPosition) return null;
    const projectionZoom = computeEquivalentPerspectiveZoom(sourceFrame.fov, targetFov);
    if (!projectionZoom) return null;
    return {
        fov: Number(targetFov),
        cameraPosition: { ...sourceFrame.cameraPosition },
        projection_zoom: projectionZoom,
    };
}

// === Three.js Module Loader (from Debug3) ===
const THREE_VERSION = "0.160.0";
const THREE_SOURCES = {
    core: new URL("../vnccs_pose_vendor/three/three.module.js", import.meta.url).href,
    orbit: new URL("../vnccs_pose_vendor/three/OrbitControls.js?v=20261017.sensitivity1", import.meta.url).href,
    transform: new URL("../vnccs_pose_vendor/three/TransformControls.js?v=20261015.3", import.meta.url).href
};

const ThreeModuleLoader = {
    promise: null,
    async load() {
        if (!this.promise) {
            this.promise = Promise.all([
                import(THREE_SOURCES.core),
                import(THREE_SOURCES.orbit),
                import(THREE_SOURCES.transform)
            ]).then(([core, orbit, transform]) => ({
                THREE: core,
                OrbitControls: orbit.OrbitControls,
                TransformControls: transform.TransformControls
            }));
        }
        return this.promise;
    }
};

export function computeSAMProjectionFrameFit({
    modelBounds,
    desiredBounds,
    fov,
    aspect,
    modelShoulderY = null,
    desiredShoulderY = null,
    desiredBottomY = null,
    safety = 1,
    minZoom = 0.1,
    maxZoom = 16,
} = {}) {
    const values = [
        modelBounds?.width,
        modelBounds?.height,
        modelBounds?.centerX,
        modelBounds?.centerY,
        modelBounds?.depth,
        desiredBounds?.width,
        desiredBounds?.height,
        desiredBounds?.centerX,
        desiredBounds?.centerY,
        fov,
        aspect,
    ].map(Number);
    if (!values.every(Number.isFinite)) return null;

    const [
        modelWidth,
        modelHeight,
        modelCenterX,
        modelCenterY,
        modelDepth,
        desiredWidth,
        desiredHeight,
        desiredCenterX,
        desiredCenterY,
        fovDegrees,
        cameraAspect,
    ] = values;
    if (
        modelWidth <= 1e-5
        || modelHeight <= 1e-5
        || modelDepth <= 1e-5
        || desiredWidth <= 1e-5
        || desiredHeight <= 1e-5
        || fovDegrees <= 0
        || cameraAspect <= 0
    ) return null;

    const modelBottomY = modelCenterY - modelHeight * 0.5;
    const useShoulderAnchor = [
        modelShoulderY,
        desiredShoulderY,
        desiredBottomY,
    ].every(value => value !== null && value !== undefined && Number.isFinite(Number(value)));
    const modelVerticalSpan = useShoulderAnchor
        ? Number(modelShoulderY) - modelBottomY
        : modelHeight;
    const desiredVerticalSpan = useShoulderAnchor
        ? Number(desiredShoulderY) - Number(desiredBottomY)
        : desiredHeight;
    if (modelVerticalSpan <= 1e-5 || desiredVerticalSpan <= 1e-5) return null;

    const safeScale = Math.max(0.5, Math.min(1.5, Number(safety) || 1));
    const zoom = Math.max(
        Number(minZoom) || 0.1,
        Math.min(
            Number(maxZoom) || 16,
            // Shoulder-to-sole height is stable across different head shapes.
            (desiredVerticalSpan / modelVerticalSpan) * safeScale,
        ),
    );
    const visibleHeight = 2 * modelDepth * Math.tan((fovDegrees * Math.PI / 180) * 0.5) / zoom;
    const visibleWidth = visibleHeight * cameraAspect;
    const scaledCenterX = modelCenterX * zoom;
    const scaledAnchorY = (
        useShoulderAnchor ? Number(modelShoulderY) : modelCenterY
    ) * zoom;
    const targetAnchorY = useShoulderAnchor
        ? Number(desiredShoulderY)
        : desiredCenterY;

    return {
        zoom,
        offset_x: -(scaledCenterX - desiredCenterX) * visibleWidth * 0.5,
        offset_y: -(scaledAnchorY - targetAnchorY) * visibleHeight * 0.5,
    };
}

export function clipSAMProjectionFrameToViewport(modelBounds, shoulderY = null) {
    const width = Number(modelBounds?.width);
    const height = Number(modelBounds?.height);
    const centerX = Number(modelBounds?.centerX);
    const centerY = Number(modelBounds?.centerY);
    const depth = Number(modelBounds?.depth);
    if (![width, height, centerX, centerY].every(Number.isFinite) || width <= 0 || height <= 0) {
        return null;
    }
    const rawMinX = centerX - width * 0.5;
    const rawMaxX = centerX + width * 0.5;
    const rawMinY = centerY - height * 0.5;
    const rawMaxY = centerY + height * 0.5;
    const minX = Math.max(-1, rawMinX);
    const maxX = Math.min(1, rawMaxX);
    const minY = Math.max(-1, rawMinY);
    const maxY = Math.min(1, rawMaxY);
    if (maxX - minX <= 1e-5 || maxY - minY <= 1e-5) return null;

    const shoulder = Number(shoulderY);
    return {
        bounds: {
            width: maxX - minX,
            height: maxY - minY,
            centerX: (minX + maxX) * 0.5,
            centerY: (minY + maxY) * 0.5,
            depth: Number.isFinite(depth) ? depth : 1,
        },
        shoulder_y: Number.isFinite(shoulder) && shoulder >= -1 && shoulder <= 1
            ? shoulder
            : null,
        bottom_y: minY,
        clipped: rawMinX < -1 || rawMaxX > 1 || rawMinY < -1 || rawMaxY > 1,
    };
}

export function clampTwoBoneReachDistance(targetDistance, totalLength) {
    const target = Math.max(0, Number(targetDistance) || 0);
    const total = Math.max(0, Number(totalLength) || 0);
    return Math.min(target, total);
}

// === IK Chain Definitions ===
const IK_CHAINS = {
    hips: {
        name: "Hips",
        isRoot: true, // Special flag - this is a root effector (translate mode)
        isRootBone: true, // Find the root bone dynamically (bone without parent)
        affectedLegs: ['leftLeg', 'rightLeg'], // Legs affected by hip movement
        iterations: 1,
        threshold: 0.01
    },
    leftArm: {
        name: "Left Arm",
        bones: ['clavicle_l', 'upperarm_l', 'lowerarm_l'],
        effector: 'hand_l',
        poleBone: 'lowerarm_l', // Bone that should point towards pole target (elbow)
        iterations: 10,
        threshold: 0.001
    },
    rightArm: {
        name: "Right Arm",
        bones: ['clavicle_r', 'upperarm_r', 'lowerarm_r'],
        effector: 'hand_r',
        poleBone: 'lowerarm_r', // Elbow
        iterations: 10,
        threshold: 0.001
    },
    leftLeg: {
        name: "Left Leg",
        bones: ['thigh_l', 'calf_l'],
        effector: 'foot_l',
        poleBone: 'calf_l', // Knee
        iterations: 30, // Increased for better accuracy
        threshold: 0.0001 // Smaller threshold
    },
    rightLeg: {
        name: "Right Leg",
        bones: ['thigh_r', 'calf_r'],
        effector: 'foot_r',
        poleBone: 'calf_r', // Knee
        iterations: 30, // Increased for better accuracy
        threshold: 0.0001 // Smaller threshold
    },
    spine: {
        name: "Spine",
        bones: ['spine_01', 'spine_02', 'spine_03', 'neck_01'],
        effector: 'head',
        iterations: 20,
        threshold: 0.01
    },
    leftShoulder: {
        name: "Left Shoulder",
        isShoulder: true,
        bones: ['clavicle_l'],
        effector: 'upperarm_l',
        iterations: 1,
        threshold: 0.001
    },
    rightShoulder: {
        name: "Right Shoulder",
        isShoulder: true,
        bones: ['clavicle_r'],
        effector: 'upperarm_r',
        iterations: 1,
        threshold: 0.01
    }
};

const SAM3D_KEYPOINT_NAMES = [
    'nose',
    'left_eye',
    'right_eye',
    'left_ear',
    'right_ear',
    'left_shoulder',
    'right_shoulder',
    'left_elbow',
    'right_elbow',
    'left_hip',
    'right_hip',
    'left_knee',
    'right_knee',
    'left_ankle',
    'right_ankle',
    'left_big_toe',
    'left_small_toe',
    'left_heel',
    'right_big_toe',
    'right_small_toe',
    'right_heel',
    'right_thumb_tip',
    'right_thumb_first_joint',
    'right_thumb_second_joint',
    'right_thumb_third_joint',
    'right_index_tip',
    'right_index_first_joint',
    'right_index_second_joint',
    'right_index_third_joint',
    'right_middle_tip',
    'right_middle_first_joint',
    'right_middle_second_joint',
    'right_middle_third_joint',
    'right_ring_tip',
    'right_ring_first_joint',
    'right_ring_second_joint',
    'right_ring_third_joint',
    'right_pinky_tip',
    'right_pinky_first_joint',
    'right_pinky_second_joint',
    'right_pinky_third_joint',
    'right_wrist',
    'left_thumb_tip',
    'left_thumb_first_joint',
    'left_thumb_second_joint',
    'left_thumb_third_joint',
    'left_index_tip',
    'left_index_first_joint',
    'left_index_second_joint',
    'left_index_third_joint',
    'left_middle_tip',
    'left_middle_first_joint',
    'left_middle_second_joint',
    'left_middle_third_joint',
    'left_ring_tip',
    'left_ring_first_joint',
    'left_ring_second_joint',
    'left_ring_third_joint',
    'left_pinky_tip',
    'left_pinky_first_joint',
    'left_pinky_second_joint',
    'left_pinky_third_joint',
    'left_wrist',
    'left_olecranon',
    'right_olecranon',
    'left_cubital_fossa',
    'right_cubital_fossa',
    'left_acromion',
    'right_acromion',
    'neck',
];

const SAM3D_JOINT_COORD_NAMES = {
    1: 'pelvis',
    2: 'thigh_l',
    3: 'calf_l',
    4: 'foot_l',
    18: 'thigh_r',
    19: 'calf_r',
    20: 'foot_r',
    35: 'spine_01',
    36: 'spine_02',
    37: 'spine_03',
    38: 'clavicle_r',
    39: 'upperarm_r',
    40: 'lowerarm_r',
    42: 'hand_r',
    44: 'pinky_01_r',
    45: 'pinky_02_r',
    46: 'pinky_03_r',
    48: 'ring_01_r',
    49: 'ring_02_r',
    50: 'ring_03_r',
    52: 'middle_01_r',
    53: 'middle_02_r',
    54: 'middle_03_r',
    56: 'index_01_r',
    57: 'index_02_r',
    58: 'index_03_r',
    60: 'thumb_01_r',
    61: 'thumb_02_r',
    62: 'thumb_03_r',
    74: 'clavicle_l',
    75: 'upperarm_l',
    76: 'lowerarm_l',
    78: 'hand_l',
    80: 'pinky_01_l',
    81: 'pinky_02_l',
    82: 'pinky_03_l',
    84: 'ring_01_l',
    85: 'ring_02_l',
    86: 'ring_03_l',
    88: 'middle_01_l',
    89: 'middle_02_l',
    90: 'middle_03_l',
    92: 'index_01_l',
    93: 'index_02_l',
    94: 'index_03_l',
    96: 'thumb_01_l',
    97: 'thumb_02_l',
    98: 'thumb_03_l',
    110: 'neck_01',
    113: 'head',
};

const SAM3D_FINGER_POINT_NAMES = [
    'thumb_01_l', 'thumb_02_l', 'thumb_03_l',
    'index_01_l', 'index_02_l', 'index_03_l',
    'middle_01_l', 'middle_02_l', 'middle_03_l',
    'ring_01_l', 'ring_02_l', 'ring_03_l',
    'pinky_01_l', 'pinky_02_l', 'pinky_03_l',
    'thumb_01_r', 'thumb_02_r', 'thumb_03_r',
    'index_01_r', 'index_02_r', 'index_03_r',
    'middle_01_r', 'middle_02_r', 'middle_03_r',
    'ring_01_r', 'ring_02_r', 'ring_03_r',
    'pinky_01_r', 'pinky_02_r', 'pinky_03_r',
];

const SAM3D_FOOT_POINT_NAMES = [
    'left_big_toe', 'left_small_toe', 'left_heel',
    'right_big_toe', 'right_small_toe', 'right_heel',
];

const SAM3D_ROTATION_PARENTS = {
    pelvis: null,
    thigh_l: 'pelvis',
    calf_l: 'thigh_l',
    foot_l: 'calf_l',
    thigh_r: 'pelvis',
    calf_r: 'thigh_r',
    foot_r: 'calf_r',
    spine_01: 'pelvis',
    spine_02: 'spine_01',
    spine_03: 'spine_02',
    clavicle_r: 'spine_03',
    upperarm_r: 'clavicle_r',
    lowerarm_r: 'upperarm_r',
    hand_r: 'lowerarm_r',
    clavicle_l: 'spine_03',
    upperarm_l: 'clavicle_l',
    lowerarm_l: 'upperarm_l',
    hand_l: 'lowerarm_l',
    neck_01: 'spine_03',
    head: 'neck_01',
};

const SAM3D_ROTATION_ORDER = [
    'pelvis',
    'spine_01', 'spine_02', 'spine_03',
    'neck_01', 'head',
    'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l',
    'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
    'thigh_l', 'calf_l', 'foot_l',
    'thigh_r', 'calf_r', 'foot_r',
];

const DEFAULT_WORLD_ROTATION_PARENT_MAP = SAM3D_ROTATION_PARENTS;

const DEFAULT_WORLD_ROTATION_ORDER = SAM3D_ROTATION_ORDER;

const SAM3D_TO_MH_BONE_MAP = {
    pelvis: 'pelvis',
    spine_01: 'spine_01',
    spine_02: 'spine_02',
    spine_03: 'spine_03',
    neck_01: 'neck_01',
    head: 'head',
    clavicle_l: 'clavicle_l',
    upperarm_l: 'upperarm_l',
    lowerarm_l: 'lowerarm_l',
    hand_l: 'hand_l',
    clavicle_r: 'clavicle_r',
    upperarm_r: 'upperarm_r',
    lowerarm_r: 'lowerarm_r',
    hand_r: 'hand_r',
    thigh_l: 'thigh_l',
    calf_l: 'calf_l',
    foot_l: 'foot_l',
    thigh_r: 'thigh_r',
    calf_r: 'calf_r',
    foot_r: 'foot_r',
    joint_096: 'thumb_01_l',
    joint_097: 'thumb_02_l',
    joint_098: 'thumb_03_l',
    joint_092: 'index_01_l',
    joint_093: 'index_02_l',
    joint_094: 'index_03_l',
    joint_088: 'middle_01_l',
    joint_089: 'middle_02_l',
    joint_090: 'middle_03_l',
    joint_084: 'ring_01_l',
    joint_085: 'ring_02_l',
    joint_086: 'ring_03_l',
    joint_080: 'pinky_01_l',
    joint_081: 'pinky_02_l',
    joint_082: 'pinky_03_l',
    joint_060: 'thumb_01_r',
    joint_061: 'thumb_02_r',
    joint_062: 'thumb_03_r',
    joint_056: 'index_01_r',
    joint_057: 'index_02_r',
    joint_058: 'index_03_r',
    joint_052: 'middle_01_r',
    joint_053: 'middle_02_r',
    joint_054: 'middle_03_r',
    joint_048: 'ring_01_r',
    joint_049: 'ring_02_r',
    joint_050: 'ring_03_r',
    joint_044: 'pinky_01_r',
    joint_045: 'pinky_02_r',
    joint_046: 'pinky_03_r',
    thumb_01_l: 'thumb_01_l',
    thumb_02_l: 'thumb_02_l',
    thumb_03_l: 'thumb_03_l',
    index_01_l: 'index_01_l',
    index_02_l: 'index_02_l',
    index_03_l: 'index_03_l',
    middle_01_l: 'middle_01_l',
    middle_02_l: 'middle_02_l',
    middle_03_l: 'middle_03_l',
    ring_01_l: 'ring_01_l',
    ring_02_l: 'ring_02_l',
    ring_03_l: 'ring_03_l',
    pinky_01_l: 'pinky_01_l',
    pinky_02_l: 'pinky_02_l',
    pinky_03_l: 'pinky_03_l',
    thumb_01_r: 'thumb_01_r',
    thumb_02_r: 'thumb_02_r',
    thumb_03_r: 'thumb_03_r',
    index_01_r: 'index_01_r',
    index_02_r: 'index_02_r',
    index_03_r: 'index_03_r',
    middle_01_r: 'middle_01_r',
    middle_02_r: 'middle_02_r',
    middle_03_r: 'middle_03_r',
    ring_01_r: 'ring_01_r',
    ring_02_r: 'ring_02_r',
    ring_03_r: 'ring_03_r',
    pinky_01_r: 'pinky_01_r',
    pinky_02_r: 'pinky_02_r',
    pinky_03_r: 'pinky_03_r',
};

// === Analytic 2-Bone IK Solver ===
export class AnalyticIKSolver {
    constructor(THREE) {
        this.THREE = THREE;
    }

    // Solve 2-bone chain analytically (100% accurate)
    solve2Bone(rootBone, midBone, effectorBone, targetPos, poleTarget, THREE) {
        // Get bone lengths from actual bone positions
        const rootPos = new THREE.Vector3();
        const midPos = new THREE.Vector3();
        const effPos = new THREE.Vector3();

        rootBone.getWorldPosition(rootPos);
        midBone.getWorldPosition(midPos);
        effectorBone.getWorldPosition(effPos);

        const upperLen = rootPos.distanceTo(midPos);
        const lowerLen = midPos.distanceTo(effPos);

        // Distance from root to target
        const targetDist = rootPos.distanceTo(targetPos);

        // Clamp to reachable range
        const totalLen = upperLen + lowerLen;
        const reachDist = clampTwoBoneReachDistance(targetDist, totalLen);

        // Law of cosines to find the bend angle at the middle joint
        // cos(A) = (a² + b² - c²) / (2ab)
        let bendAngle = 0;
        if (reachDist > 0.001 && upperLen > 0.001 && lowerLen > 0.001) {
            const cosAngle = (upperLen * upperLen + lowerLen * lowerLen - reachDist * reachDist) / (2 * upperLen * lowerLen);
            bendAngle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
        }

        // Direction from root to target
        const dirToTarget = new THREE.Vector3().subVectors(targetPos, rootPos).normalize();

        // Calculate bend direction (perpendicular to dirToTarget, towards pole)
        // Use the parent's world orientation (usually Hips) to derive a stable "local-forward" fallback.
        // This prevents the knee from snapping to world-front when the character is rotated.
        const refBone = rootBone.parent || rootBone;
        const refQuat = new THREE.Quaternion();
        refBone.getWorldQuaternion(refQuat);
        let bendDir = new THREE.Vector3(0, 0, 1).applyQuaternion(refQuat);

        if (poleTarget) {
            // Project pole position onto plane perpendicular to dirToTarget
            const toPole = new THREE.Vector3().subVectors(poleTarget, rootPos);
            const poleProj = toPole.clone().sub(dirToTarget.clone().multiplyScalar(toPole.dot(dirToTarget)));
            if (poleProj.lengthSq() > 0.001) {
                bendDir = poleProj.normalize();
            }
        } else {
            // Default: bend forward (for knees) or backward (for elbows)
            // Use a hint based on the current mid bone position
            const toMid = new THREE.Vector3().subVectors(midPos, rootPos);
            const midProj = toMid.clone().sub(dirToTarget.clone().multiplyScalar(toMid.dot(dirToTarget)));
            if (midProj.lengthSq() > 0.001) {
                bendDir = midProj.normalize();
            }
        }

        // Calculate the angle at root joint
        // Distance from root to the middle point
        const reachRatio = reachDist / totalLen;
        const midDist = upperLen;

        // Angle at root: angle between dirToTarget and the upper bone direction
        // Using law of cosines again
        let rootAngle = 0;
        if (reachDist > 0.001) {
            const cosRoot = (upperLen * upperLen + reachDist * reachDist - lowerLen * lowerLen) / (2 * upperLen * reachDist);
            rootAngle = Math.acos(Math.max(-1, Math.min(1, cosRoot)));
        }

        // Calculate upper bone direction
        // The rotation axis should be perpendicular to both dirToTarget and the bend plane (bendDir)
        let axis = new THREE.Vector3().crossVectors(dirToTarget, bendDir);

        let upperDir;
        if (axis.lengthSq() < 0.0001) {
            // Singularity fallback: if target is perfectly aligned with bendDir, pick any arbitrary perpendicular axis
            axis = new THREE.Vector3(1, 0, 0);
            if (Math.abs(dirToTarget.x) > 0.9) axis.set(0, 1, 0);
            axis.cross(dirToTarget).normalize();
        } else {
            axis.normalize();
        }

        // Rotate target direction towards the bend direction
        const rotQuat = new THREE.Quaternion().setFromAxisAngle(axis, rootAngle);
        upperDir = dirToTarget.clone().applyQuaternion(rotQuat);

        // Calculate target mid position
        const targetMidPos = rootPos.clone().add(upperDir.clone().multiplyScalar(upperLen));

        // Now we need to rotate rootBone so its child (midBone) is at targetMidPos
        // And rotate midBone so its child (effectorBone) is at targetPos

        // === Rotate root bone ===
        this.rotateBoneToPoint(rootBone, midPos, targetMidPos, THREE);

        // Update matrices after root rotation
        rootBone.updateMatrixWorld(true);

        // Get new mid position after root rotation
        midBone.getWorldPosition(midPos);

        // === Rotate mid bone ===
        // IMPORTANT: Must refresh effector world position because it moved with its parent!
        effectorBone.getWorldPosition(effPos);
        this.rotateBoneToPoint(midBone, effPos, targetPos, THREE);

        // Update matrices
        midBone.updateMatrixWorld(true);

        return true;
    }

    rotateBoneToPoint(bone, currentChildPos, targetChildPos, THREE) {
        // Get bone world position
        const bonePos = new THREE.Vector3();
        bone.getWorldPosition(bonePos);

        // Direction from bone to current child position
        const currentDir = new THREE.Vector3().subVectors(currentChildPos, bonePos).normalize();

        // Direction from bone to target child position
        const targetDir = new THREE.Vector3().subVectors(targetChildPos, bonePos).normalize();

        // Calculate rotation
        const dot = currentDir.dot(targetDir);
        if (dot > 1 - 1e-12) return; // Already aligned to sub-pixel precision

        const axis = new THREE.Vector3().crossVectors(currentDir, targetDir);
        let angle = Math.acos(Math.max(-1, Math.min(1, dot)));

        if (axis.lengthSq() < 1e-12) {
            // Singularity: 180 degree rotation. Pick any perpendicular axis.
            if (dot < 0) {
                const perp = new THREE.Vector3(1, 0, 0);
                if (Math.abs(currentDir.x) > 0.9) perp.set(0, 1, 0);
                axis.crossVectors(currentDir, perp).normalize();
            } else {
                return; // Already aligned (0 degrees)
            }
        } else {
            axis.normalize();
        }

        // Create rotation quaternion in world space
        const worldRotQuat = new THREE.Quaternion().setFromAxisAngle(axis, angle);

        // Get current world quaternion
        const currentWorldQuat = new THREE.Quaternion();
        bone.getWorldQuaternion(currentWorldQuat);

        // Apply rotation in world space
        const newWorldQuat = worldRotQuat.multiply(currentWorldQuat);

        // Convert to local quaternion
        if (bone.parent) {
            const parentWorldQuat = new THREE.Quaternion();
            bone.parent.getWorldQuaternion(parentWorldQuat);
            const invParentQuat = parentWorldQuat.clone().invert();
            newWorldQuat.premultiply(invParentQuat);
        }

        bone.quaternion.copy(newWorldQuat);
    }
}

// === CCD IK Solver ===
class CCDIKSolver {
    constructor(THREE) {
        this.THREE = THREE;
        this.analyticSolver = new AnalyticIKSolver(THREE);
    }

    solve(chainDef, bones, target, poleTarget = null) {
        const THREE = this.THREE;

        const chainBones = chainDef.bones.map(name => bones[name]).filter(b => b);
        const effectorBone = bones[chainDef.effector];
        const poleBone = chainDef.poleBone ? bones[chainDef.poleBone] : null;

        if (!effectorBone || chainBones.length === 0) {
            return false;
        }

        // Use analytic solver for 2-bone chains (much more accurate)
        if (chainBones.length === 2) {
            return this.analyticSolver.solve2Bone(
                chainBones[0],
                chainBones[1],
                effectorBone,
                target,
                poleTarget,
                THREE
            );
        }

        // For 3-bone chains (arms with clavicle), use analytic solver for last 2 bones
        // This gives accurate pole target behavior like legs
        if (chainBones.length === 3) {
            // chainBones[0] = clavicle (skip for IK)
            // chainBones[1] = upperarm
            // chainBones[2] = lowerarm
            return this.analyticSolver.solve2Bone(
                chainBones[1], // upperarm
                chainBones[2], // lowerarm
                effectorBone,  // hand
                target,
                poleTarget,
                THREE
            );
        }

        // Fall back to CCD for longer chains
        const effectorWorldPos = new THREE.Vector3();
        effectorBone.getWorldPosition(effectorWorldPos);

        const initialDist = effectorWorldPos.distanceTo(target);
        if (initialDist < chainDef.threshold) {
            return true;
        }

        for (let iter = 0; iter < chainDef.iterations; iter++) {
            for (let i = chainBones.length - 1; i >= 0; i--) {
                const bone = chainBones[i];

                effectorBone.getWorldPosition(effectorWorldPos);

                const dist = effectorWorldPos.distanceTo(target);
                if (dist < chainDef.threshold) {
                    return true;
                }

                const boneWorldPos = new THREE.Vector3();
                bone.getWorldPosition(boneWorldPos);

                const toEffector = effectorWorldPos.clone().sub(boneWorldPos).normalize();
                const toTarget = target.clone().sub(boneWorldPos).normalize();

                const dot = toEffector.dot(toTarget);

                if (dot > 0.9999) continue;

                const clampedDot = Math.max(-1, Math.min(1, dot));
                const angle = Math.acos(clampedDot);

                if (angle < 0.0001) continue;

                const axis = new THREE.Vector3().crossVectors(toEffector, toTarget).normalize();

                if (axis.lengthSq() < 0.0001) continue;

                const maxAngle = Math.PI / 4;
                const limitedAngle = Math.min(angle, maxAngle);

                const boneWorldQuat = new THREE.Quaternion();
                bone.getWorldQuaternion(boneWorldQuat);

                const worldRotQuat = new THREE.Quaternion().setFromAxisAngle(axis, limitedAngle);
                const newWorldQuat = worldRotQuat.multiply(boneWorldQuat);

                if (bone.parent) {
                    const parentWorldQuat = new THREE.Quaternion();
                    bone.parent.getWorldQuaternion(parentWorldQuat);
                    const invParentQuat = parentWorldQuat.clone().invert();
                    newWorldQuat.premultiply(invParentQuat);
                }

                bone.quaternion.copy(newWorldQuat);
                bone.updateMatrixWorld(true);
            }
        }

        // Apply pole target constraint ONCE at the end (not every iteration to avoid accumulation)
        if (poleTarget && poleBone && chainBones.length >= 2) {
            this.applyPoleConstraint(chainBones, poleBone, target, poleTarget, THREE);
        }

        effectorBone.getWorldPosition(effectorWorldPos);
        return effectorWorldPos.distanceTo(target) < chainDef.threshold;
    }

    applyPoleConstraint(chainBones, poleBone, effectorTarget, poleTarget, THREE) {
        // For 2-bone chains (legs): chainBones[0]=thigh, chainBones[1]=calf
        // For 3-bone chains (arms): chainBones[0]=clavicle, chainBones[1]=upperarm, chainBones[2]=lowerarm

        // Use poleBone for elbow/knee position (passed as parameter)
        if (!poleBone) return;

        // For 3-bone chains, we need to rotate upperarm (index 1), not clavicle (index 0)
        // For 2-bone chains, we rotate the first bone (thigh)
        const boneToRotate = chainBones.length >= 3 ? chainBones[1] : chainBones[0];
        if (!boneToRotate) return;

        // Get positions - use boneToRotate position as root for calculations
        const rootPos = new THREE.Vector3();
        const polePos = new THREE.Vector3();

        boneToRotate.getWorldPosition(rootPos); // Position of upperarm/thigh
        poleBone.getWorldPosition(polePos); // Position of elbow/knee

        // Calculate the bend plane
        const rootToTarget = effectorTarget.clone().sub(rootPos).normalize();
        const rootToPole = poleTarget.clone().sub(rootPos).normalize();

        // Calculate the desired bend direction (perpendicular to root->target, towards pole)
        const bendAxis = new THREE.Vector3().crossVectors(rootToTarget, rootToPole).normalize();

        if (bendAxis.lengthSq() < 0.0001) return;

        // Get current bend direction from boneToRotate to poleBone (elbow/knee)
        const currentBend = polePos.clone().sub(rootPos).normalize();

        // Project current bend onto plane perpendicular to root->target
        const projectedCurrent = currentBend.clone().sub(
            rootToTarget.clone().multiplyScalar(currentBend.dot(rootToTarget))
        ).normalize();

        // Project desired bend (towards pole) onto same plane
        const projectedDesired = rootToPole.clone().sub(
            rootToTarget.clone().multiplyScalar(rootToPole.dot(rootToTarget))
        ).normalize();

        // Calculate rotation angle to align with pole
        const dot = projectedCurrent.dot(projectedDesired);
        if (Math.abs(dot) > 0.9999) return;

        const clampedDot = Math.max(-1, Math.min(1, dot));
        let rotationAngle = Math.acos(clampedDot);

        // Check rotation direction
        const cross = new THREE.Vector3().crossVectors(projectedCurrent, projectedDesired);
        if (cross.dot(rootToTarget) < 0) {
            rotationAngle = -rotationAngle;
        }

        // Apply rotation to the correct bone (upperarm for arms, thigh for legs)
        const boneWorldQuat = new THREE.Quaternion();
        boneToRotate.getWorldQuaternion(boneWorldQuat);

        // Create rotation around the target direction axis
        const poleRotationQuat = new THREE.Quaternion().setFromAxisAngle(rootToTarget, rotationAngle * 0.5);
        const newWorldQuat = poleRotationQuat.multiply(boneWorldQuat);

        if (boneToRotate.parent) {
            const parentWorldQuat = new THREE.Quaternion();
            boneToRotate.parent.getWorldQuaternion(parentWorldQuat);
            const invParentQuat = parentWorldQuat.clone().invert();
            newWorldQuat.premultiply(invParentQuat);
        }

        boneToRotate.quaternion.copy(newWorldQuat);
        boneToRotate.updateMatrixWorld(true);
    }
}

// === IK Controller ===
class IKController {
    constructor(THREE) {
        this.THREE = THREE;
        this.ccdSolver = new CCDIKSolver(THREE);
        this.activeChains = new Set();
        this.effectors = {};
        this.poleTargets = {}; // Pole target meshes
        this.poleModes = {}; // 'on' or 'off' for each chain
        this.modes = {};

        Object.keys(IK_CHAINS).forEach(key => {
            this.modes[key] = 'ik';
            this.activeChains.add(key);
            this.poleModes[key] = 'off'; // Disabled by default, solves the target passing twist issue
        });
    }

    setMode(chainKey, mode) {
        this.modes[chainKey] = mode;
        if (mode === 'ik') {
            this.activeChains.add(chainKey);
        } else {
            this.activeChains.delete(chainKey);
        }
    }

    getMode(chainKey) {
        return this.modes[chainKey] || 'fk';
    }

    setPoleMode(chainKey, mode) {
        this.poleModes[chainKey] = mode;
    }

    getPoleMode(chainKey) {
        return this.poleModes[chainKey] || 'off';
    }

    isPoleTargetEnabled(chainKey) {
        return this.poleModes[chainKey] === 'on' && this.modes[chainKey] === 'ik';
    }

    isEffector(boneName) {
        for (const key in IK_CHAINS) {
            if (IK_CHAINS[key].effector === boneName && this.modes[key] === 'ik') {
                return true;
            }
        }
        return false;
    }

    getChainForEffector(boneName) {
        for (const key in IK_CHAINS) {
            if (IK_CHAINS[key].effector === boneName) {
                return key;
            }
        }
        return null;
    }

    getChainForBone(boneName) {
        for (const key in IK_CHAINS) {
            const chain = IK_CHAINS[key];
            if (chain.effector === boneName || (chain.bones && chain.bones.includes(boneName))) {
                return key;
            }
        }
        return null;
    }

    getChainForPoleTarget(meshName) {
        for (const key in IK_CHAINS) {
            if (`pole_${key}` === meshName) {
                return key;
            }
        }
        return null;
    }

    solve(bones, effectorTargets) {
        for (const chainKey of this.activeChains) {
            const chainDef = IK_CHAINS[chainKey];
            const target = effectorTargets.get(chainDef.effector);

            if (target) {
                this.ccdSolver.solve(chainDef, bones, target);
            }
        }
    }

    solveWithPole(chainDef, bones, effectorTarget, chainKey) {
        let poleTarget = null;

        // Check if pole target is enabled for this chain
        if (this.isPoleTargetEnabled(chainKey) && this.poleTargets[chainKey]) {
            poleTarget = this.poleTargets[chainKey].position.clone();
        }

        // Keep leg bend direction stable even when no explicit pole target is active.
        if (!poleTarget && (chainKey === 'leftLeg' || chainKey === 'rightLeg')) {
            const poleBoneName = chainDef.poleBone;
            const poleBone = poleBoneName ? bones[poleBoneName] : null;
            if (poleBone) {
                const THREE = this.ccdSolver.THREE;
                poleTarget = new THREE.Vector3();
                poleBone.getWorldPosition(poleTarget);
            }
        }

        return this.ccdSolver.solve(chainDef, bones, effectorTarget, poleTarget);
    }

    createEffectorHelper(effectorName, bone, THREE, isRoot = false) {
        // Use an empty Object3D instead of a mesh so it remains invisible
        // but still holds position and rotation for the IK solver.
        const helper = new THREE.Object3D();


        helper.name = `ik_effector_${effectorName}`;
        helper.userData.effectorName = effectorName;
        helper.userData.type = 'effector';
        helper.userData.isRoot = isRoot;


        // Don't set position here - it will be set by createIKEffectorHelpers

        this.effectors[effectorName] = helper;

        return helper;
    }

    createPoleTargetHelper(chainKey, poleBone, THREE) {
        // Use an empty Object3D instead of a mesh
        const helper = new THREE.Object3D();

        helper.name = `pole_${chainKey}`;
        helper.userData.chainKey = chainKey;
        helper.userData.type = 'poleTarget';

        this.poleTargets[chainKey] = helper;

        return helper;
    }

    updateEffectorPosition(effectorName, bone) {
        const helper = this.effectors[effectorName];
        if (helper && bone) {
            const bonePos = new this.THREE.Vector3();
            bone.getWorldPosition(bonePos);
            helper.position.copy(bonePos);
        }
    }
}


export class PoseViewerCore {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.width = canvas.width || 500;
        this.height = canvas.height || 500;
        this.shoulderIKEnabled = true;
        this._rtmwSavedCamera = null;
        this._rtmwCameraParented = true;
        this._mannequinVisible = true;

        // Default constraints based on standard UI Embedding requirements
        this.options = {
            onPoseChange: null,
            onError: console.error,
            onInteractionStart: null,
            onInteractionEnd: null,
            onHandHover: null,
            onHandActivate: null,
            onBoneSelectionChange: null,

            syncMode: 'end',
            skinMode: 'flat_color',

            showSkeletonHelper: true,
            showCaptureFrame: true,
            showReferenceImage: true,

            enableMultiPass: true,
            enableTextureSkinning: true,

            orbitEnabled: true,
            ikEnabled: true,
            ...options
        };

        this.THREE = null;
        this.OrbitControls = null;
        this.TransformControls = null;

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.orbit = null;
        this.transform = null;

        this.skinnedMesh = null;
        this.skeleton = null;
        this.boneList = [];
        this.bones = {};
        // The selected character owns the editable rig above. Other scene
        // characters are lightweight independent rig clones with no markers,
        // IK helpers, or TransformControls, so they remain visible but inert.
        this.passiveCharacters = new Map();
        this.activeCharacterAppearance = {
            color: "#ffffff",
            transform: { x: 0, y: 0, z: 0, zoom: 1 },
        };
        this.modelLandmarks = {};
        this.modelLandmarkIndices = {};
        this._centerHipBoneName = null;
        this.selectedBone = null;
        this.hoveredBoneName = null;
        this.externalHoveredBoneName = null;
        this._emittingBoneSelectionChange = false;

        this.jointMarkers = [];

        // Pose state
        this.modelRotation = { x: 0, y: 0, z: 0 };
        this.importedFigureVisible = true;
        this.samMeshOverlayVisible = false;
        this._samMeshOverlayGroup = null;
        this._samMeshOverlayWorldKps = null;
        this._samMeshOverlaySourceFrame = null;
        this._samProjectionCameraFrame = null;

        this.initialized = false;

        // Undo/Redo History
        this.history = [];
        this.future = [];
        this.maxHistory = 10;
        this.headScale = 1.0;
        this.armScale = 1.0;
        this.handScale = 1.0;
        this.footScale = 1.0;
        this.boneLengthParams = {
            shoulder_l: 0.5,
            shoulder_r: 0.5,
            hip_l: 0.5,
            hip_r: 0.5,
            upper_arm_l: 0.5,
            upper_arm_r: 0.5,
            forearm_l: 0.5,
            forearm_r: 0.5,
            thigh_l: 0.5,
            thigh_r: 0.5,
            shin_l: 0.5,
            shin_r: 0.5,
            spine: 0.5,
        };
        this.shapedBoneRestPositions = {};

        this.pendingData = null;
        this.pendingBackgroundUrl = null;
        this.cachedSkinTexture = null;
        this.cachedSkinType = null;
        this._cachedSkinTextureReady = false;
        this._skinTextureLoadToken = 0;
        this._skinTextureReady = true;
        this._skinTexturePromise = Promise.resolve(true);
        this._captureBatch = null;
        this._needsRender = true;
        this._renderFrame = null;
        this._viewportSizeObserved = false;
        this._viewportBufferLocked = false;
        this._hoverPointerFrame = null;
        this._pendingHoverPointer = null;

        // IK State
        this.ikController = null;
        this.ikMode = this.options.ikEnabled;
        this.ikEffectorTargets = new Map();
        this.selectedIKEffector = null; // Currently selected IK effector mesh
        this.selectedPoleTarget = null; // Currently selected pole target mesh

        // Throttling state for setPose sync
        this.isDispatching = false;
        this.queuedSyncFrame = null;
        this.cameraParams = null; // Store widget camera params explicitly
        this.isInteractionActive = null;
        this._hoveredHandSide = null;
        this.useHandControlPopover = this.options.useHandControlPopover !== false;
    }

    _getHandSideFromBoneName(name) {
        if (!name) return null;
        const lower = name.toLowerCase();
        if (!lower.endsWith('_l') && !lower.endsWith('_r')) return null;
        if (!/(hand|thumb|index|middle|ring|pinky)/.test(lower)) return null;
        return lower.endsWith('_l') ? 'l' : 'r';
    }

    _isFingerHandBoneName(name) {
        if (!name) return false;
        const lower = name.toLowerCase();
        return /^(thumb|index|middle|ring|pinky)(?:_|$)|\bfinger\b/.test(lower);
    }

    _shouldMarkerBeVisible(marker) {
        if (this._multiCharacterSelection || this._noCharacterSelection) return false;
        const bone = this.boneList?.[marker?.userData?.boneIndex];
        if (!bone) return false;
        const parentName = bone.userData?.parentName;
        const isRigRoot = !parentName || !this.bones?.[parentName];
        if (isRigRoot && bone.name !== this._centerHipBoneName) return false;
        if (!this.useHandControlPopover) return true;
        return !this._isFingerHandBoneName(bone.name);
    }

    _getRaycastableJointMarkers() {
        if (!this._raycastableJointMarkers) this._raycastableJointMarkers = [];
        this._raycastableJointMarkers.length = 0;
        for (const marker of this.jointMarkers || []) {
            if (marker?.visible) this._raycastableJointMarkers.push(marker);
        }
        return this._raycastableJointMarkers;
    }

    _resolveHandBone(bone) {
        if (!this.useHandControlPopover) return bone;
        const side = this._getHandSideFromBoneName(bone?.name);
        if (!side) return bone;
        return this.bones?.[`hand_${side}`] || bone;
    }

    _isHandSurfaceActivation(side, point) {
        if (!this.useHandControlPopover) return false;
        if (!side || !point || !this.THREE) return false;

        const wrist = this.bones?.[`hand_${side}`];
        const middleBase = this.bones?.[`middle_01_${side}`];
        const indexBase = this.bones?.[`index_01_${side}`] || middleBase;
        const ringBase = this.bones?.[`ring_01_${side}`] || middleBase;
        if (!wrist || !middleBase) return false;

        const wristPos = new this.THREE.Vector3();
        const middlePos = new this.THREE.Vector3();
        const indexPos = new this.THREE.Vector3();
        const ringPos = new this.THREE.Vector3();
        wrist.getWorldPosition(wristPos);
        middleBase.getWorldPosition(middlePos);
        indexBase.getWorldPosition(indexPos);
        ringBase.getWorldPosition(ringPos);

        const palmCenter = new this.THREE.Vector3()
            .add(middlePos)
            .add(indexPos)
            .add(ringPos)
            .multiplyScalar(1 / 3);

        const handDir = palmCenter.clone().sub(wristPos);
        const handLength = handDir.length();
        if (handLength < 1e-4) return false;

        handDir.normalize();
        const clickOffset = point.clone().sub(wristPos);
        const alongHand = clickOffset.dot(handDir);
        const wristDeadZone = Math.max(0.12, handLength * 0.32);

        return alongHand > wristDeadZone;
    }

    _updateHoveredHand(side) {
        if (!this.useHandControlPopover) side = null;
        if (this._hoveredHandSide === side) return;
        this._hoveredHandSide = side;

        if (side) {
            this.showHandHighlightRing(side);
        } else {
            this.hideHandHighlightRing();
        }

        if (this.options.onHandHover) {
            this.options.onHandHover({ side });
        }
    }

    setUseHandControlPopover(enabled) {
        this.useHandControlPopover = enabled !== false;
        if (!this.useHandControlPopover) {
            this._updateHoveredHand(null);
        }
        if (this.jointMarkers) {
            this.jointMarkers.forEach(marker => {
                marker.visible = this._mannequinVisible !== false && this._shouldMarkerBeVisible(marker);
            });
        }
        this.updateMarkers();
        this.requestRender();
    }

    dispatchPoseChange() {
        if (!this.options.onPoseChange) return;

        if (this.options.syncMode === 'raf') {
            if (!this.queuedSyncFrame) {
                this.queuedSyncFrame = requestAnimationFrame(() => {
                    this.options.onPoseChange(this.getPose());
                    this.queuedSyncFrame = null;
                });
            }
        } else if (this.options.syncMode === 'end') {
            // If we are currently interacting, 'end' mode means suppress until interaction finishes.
            if (!this.isInteractionActive) {
                this.options.onPoseChange(this.getPose());
            }
        }
    }

    // === Public API Lifecycle ===

    isInitialized() {
        return this.initialized && this.skinnedMesh !== null;
    }

    isCaptureReady() {
        return this.isInitialized() && this._skinTextureReady !== false
            && this._referenceTextureReady !== false && !this._referenceTextureError;
    }

    async waitForCaptureReady() {
        while (!this._disposed) {
            const skin = this._skinTexturePromise;
            const reference = this._referenceTexturePromise;
            await Promise.all([skin, reference]);
            if (this._disposed) break;
            if (skin !== this._skinTexturePromise || reference !== this._referenceTexturePromise) continue;
            if (this._referenceTextureError) throw new Error(this._referenceTextureError);
            return true;
        }
        throw new Error("Pose Studio was disposed.");
    }

    dispose() {
        this._disposed = true;
        this.initialized = false;
        if (this._clearCharacterAxisHoverOnCtrlRelease) {
            window.removeEventListener("keyup", this._clearCharacterAxisHoverOnCtrlRelease, true);
            this._clearCharacterAxisHoverOnCtrlRelease = null;
        }
        if (this._setCharacterAxisCtrlMode) {
            window.removeEventListener("keydown", this._setCharacterAxisCtrlMode, true);
            this._setCharacterAxisCtrlMode = null;
        }
        if (this._axisRightPressMove) window.removeEventListener("pointermove", this._axisRightPressMove, true);
        if (this._axisRightPressEnd) {
            window.removeEventListener("pointerup", this._axisRightPressEnd, true);
            window.removeEventListener("pointercancel", this._axisRightPressEnd, true);
        }
        this._axisRightPress = null;
        if (this._jointLockPointerDown) window.removeEventListener("pointerdown", this._jointLockPointerDown, true);
        if (this._jointLockPointerMove) window.removeEventListener("pointermove", this._jointLockPointerMove, true);
        if (this._jointLockPointerUp) {
            window.removeEventListener("pointerup", this._jointLockPointerUp, true);
            window.removeEventListener("pointercancel", this._jointLockPointerUp, true);
        }
        this._jointLockPress = null;
        this._jointLockClick = null;
        this._rotationGuideSvg?.remove?.();
        this._rotationGuideSvg = null;
        this._rotationGuideCircle = null;
        this._referenceGeneration = (this._referenceGeneration || 0) + 1;
        this._resolveReferenceTexture?.(false);
        this._skinTextureLoadToken += 1;
        this._skinTextureReady = false;

        if (this._renderFrame) {
            cancelAnimationFrame(this._renderFrame);
            this._renderFrame = null;
        }
        if (this._hoverPointerFrame) {
            cancelAnimationFrame(this._hoverPointerFrame);
            this._hoverPointerFrame = null;
        }
        this._pendingHoverPointer = null;
        if (this.queuedSyncFrame) {
            cancelAnimationFrame(this.queuedSyncFrame);
            this.queuedSyncFrame = null;
        }

        if (this.transform) {
            this.transform.detach();
            if (this.transform.parent) this.transform.parent.remove(this.transform);
            this.transform.dispose();
            this.transform = null;
        }

        if (this.orbit) {
            this.orbit.dispose();
            this.orbit = null;
        }

        this.clearPassiveCharacters();
        this.skeleton?.dispose?.();
        this.skeletonHelper?.geometry?.dispose?.();
        this.skeletonHelper?.material?.dispose?.();
        this.cachedSkinTexture?.dispose?.();
        this.cachedSkinTexture = null;

        if (this.renderer) {
            this.renderer.dispose();
            if (this.renderer.domElement && this.renderer.domElement.parentNode) {
                // Don't modify the shell's DOM, just clean up WebGL
            }
            this.renderer = null;
        }

        if (this.scene) {
            // Traverse and dispose materials/geometries
            this.scene.traverse((object) => {
                if (!object.isMesh) return;

                if (object.geometry) {
                    object.geometry.dispose();
                }

                if (object.material) {
                    if (Array.isArray(object.material)) {
                        object.material.forEach(material => material.dispose());
                    } else {
                        object.material.dispose();
                    }
                }
            });
            this.scene = null;
        }

        // Drop references
        this.skinnedMesh = null;
        this.skeleton = null;
        this.bones = {};
        this.boneList = [];
        this.passiveCharacters = new Map();
        this.shapedBoneRestPositions = {};
        this.sceneCameraTarget = null;
        this.ikController = null;
        this._captureBatch = null;
        this._viewportBufferLocked = false;
        this._raycaster = null;
        this._pointerNdc = null;
        this._pointerWorldPosition = null;
        this._dragIntersectPoint = null;
        this.options = null;
    }

    async init() {
        try {
            const modules = await ThreeModuleLoader.load();
            if (this._disposed) return false;
            this.THREE = modules.THREE;
            this.OrbitControls = modules.OrbitControls;
            this.TransformControls = modules.TransformControls;

            this.setupScene();

            this.initialized = true;

            // Apply buffered data after initialized=true
            if (this.pendingData) {
                this.loadData(this.pendingData.data, this.pendingData.keepCamera);
                this.pendingData = null;
            }

            if (this.pendingBackgroundUrl) {
                this.loadReferenceImage(this.pendingBackgroundUrl);
                this.pendingBackgroundUrl = null;
            }

            this.requestRender(); // Initial render
        } catch (e) {
            console.error('Pose Studio: Init failed', e);
        }
    }

    setupScene() {
        const THREE = this.THREE;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x000000);

        this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 1000);
        this.camera.position.set(0, 10, 30);
        this.scene.add(this.camera);

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: this.options.transparentBackground === true,
            preserveDrawingBuffer: true
        });
        if (this.options.transparentBackground) {
            this.scene.background = null;
            this.renderer.setClearColor(0x000000, 0);
        }
        this.renderer.setSize(this.width, this.height, false); // false = don't write canvas CSS style
        // resize() may have received the real DOM viewport while Three.js modules
        // were still loading. In that case this is already the stable editor buffer.
        this._viewportBufferLocked = this._viewportSizeObserved;
        // More than 2x DPR is very costly for a preserveDrawingBuffer WebGL canvas
        // and brings little visible benefit inside a graph node.
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this._raycaster = new THREE.Raycaster();
        this._pointerNdc = new THREE.Vector2();
        this._pointerWorldPosition = new THREE.Vector3();
        this._dragIntersectPoint = new THREE.Vector3();
        this._characterControlDrag = null;
        this._rotationGuideActive = false;
        this.canvas.addEventListener("pointerdown", event => {
            if (this._lockedBoneName) {
                this._selectionClickStart = null;
                return;
            }
            const selectedCharacterShiftGesture = !this._noCharacterSelection
                && this._mannequinVisible !== false
                && this.skinnedMesh
                && event.shiftKey
                && (event.button === 0 || event.button === 2);
            if (selectedCharacterShiftGesture) {
                this._selectionClickStart = null;
                this._blockedSelectionPointerId = event.pointerId;
                this.canvas.setPointerCapture(event.pointerId);
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
            // Ctrl+left on a joint is still a joint-selection gesture. Let the
            // normal joint picker handle it instead of recording a character
            // pick that would clear the selected bone on pointerup.
            if (event.ctrlKey && event.button === 0 && this._getJointMarkerAtPointer(event)) {
                this._selectionClickStart = null;
                return;
            }
            this._selectionClickStart = { x: event.clientX, y: event.clientY, id: event.pointerId, ctrl: event.ctrlKey, hit: this.pickCharacterAtPointer(event) };
            if (this._noCharacterSelection && (event.shiftKey || event.ctrlKey && event.button !== 0)) {
                this._blockedSelectionPointerId = event.pointerId;
                this.canvas.setPointerCapture(event.pointerId);
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }, true);
        this.canvas.addEventListener("pointerup", event => {
            const start = this._selectionClickStart;
            this._selectionClickStart = null;
            if (event.button !== 0 || !start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
            const hit = this.pickCharacterAtPointer(event);
            if (hit && start.hit && hit.id === start.hit.id && hit.active === start.hit.active) {
                if (start.ctrl || !hit.active || this._multiCharacterSelection || this._noCharacterSelection) {
                    // Finish the old character's gesture before switching rigs.
                    this.finishCharacterControlDrag(event);
                    this.options.onCharacterPick?.(hit.active ? null : hit.id, start.ctrl);
                }
            } else if (!hit && !start.hit && !start.ctrl) this.options.onCharacterSelectionClear?.();
        }, true);
        this.canvas.addEventListener("pointerup", event => {
            if (event.pointerId !== this._blockedSelectionPointerId) return;
            this._blockedSelectionPointerId = null;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
        this.canvas.addEventListener("pointercancel", event => {
            if (event.pointerId !== this._blockedSelectionPointerId) return;
            this._blockedSelectionPointerId = null;
            this._selectionClickStart = null;
            event.stopImmediatePropagation();
        }, true);
        this.canvas.addEventListener("pointerdown", (event) => this.beginCharacterControlDrag(event), true);
        this.canvas.addEventListener("pointermove", event => {
            if (event.pointerId !== this._blockedSelectionPointerId && !(this._noCharacterSelection && (event.ctrlKey || event.shiftKey))) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
        this.canvas.addEventListener("pointermove", (event) => {
            const hovered = this._rotationGuideActive
                && this._isOnCharacterRotationGuide(event.clientX, event.clientY);
            if (hovered === this._rotationGuideHovered) return;
            this._rotationGuideHovered = hovered;
            this._refreshCharacterRotationGuideStyle();
        }, true);
        this.canvas.addEventListener("pointerleave", () => {
            this._rotationGuideHovered = false;
            this._refreshCharacterRotationGuideStyle();
        }, true);
        this.canvas.addEventListener("pointermove", (event) => this.moveCharacterControlDrag(event), true);
        this.canvas.addEventListener("pointerup", (event) => this.finishCharacterControlDrag(event), true);
        this.canvas.addEventListener("pointercancel", (event) => this.finishCharacterControlDrag(event), true);
        this.canvas.addEventListener("contextmenu", (event) => {
            if (this._noCharacterSelection && (event.ctrlKey || event.shiftKey)) {
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
            if (event.ctrlKey || event.shiftKey || (this._rotationGuideActive && this._isInsideCharacterRotationGuide(event.clientX, event.clientY))) {
                event.preventDefault();
            }
        });

        // Orbit Controls
        this.orbit = new this.OrbitControls(this.camera, this.canvas);
        this.orbit.target.set(0, 10, 0);
        this.orbit.enableDamping = false;
        this.orbit.rotateSpeed = TRACKBALL_ROTATION_GAIN;
        this.orbit.enableTrackballRotation = true;
        this.orbit.getRotationPivot = () => {
            // When one character is selected, keep view rotation centered on
            // that character's own XYZ origin. Otherwise orbit the scene frame.
            return this._getViewRotationPivot();
        };
        // 视图与人物共用固定屏幕轨迹球半径；枢轴分别是画框中心与人物白点。
        this.orbit.getTrackballPixelRadius = pivot => this._viewTrackballPixelRadius(pivot);
        this.orbit.enableZoom = false;
        this.orbit.mouseButtons = {
            LEFT: this.THREE.MOUSE.PAN,
            MIDDLE: this.THREE.MOUSE.PAN,
            RIGHT: this.THREE.MOUSE.ROTATE,
        };
        this.orbit.update();
        // Keep the editing viewport parallel by default.
        this.setViewportProjection("parallel");

        this._handleViewportWheel = e => {
            e.preventDefault();
            e.stopPropagation(); // capture before ComfyUI graph zoom/pan
            e.stopImmediatePropagation();
            if (e.shiftKey && !e.ctrlKey) return;
            const delta = e.deltaY;
            const absDelta = Math.abs(delta);
            if (e.ctrlKey) {
                if (this._noCharacterSelection) return;
                if (this._mannequinVisible === false || !this.skinnedMesh) return;
                this.recordState();
                const group = this.createCharacterControlGroup?.();
                if (group) {
                    let factor = 1.0 - Math.sign(delta) * Math.min(0.004 * absDelta, 0.075);
                    factor = Math.max(...group.items.map(item => 0.1 / item.zoom), Math.min(factor, ...group.items.map(item => 7 / item.zoom)));
                    this.applyCharacterControlGroup(group, { scale: factor, commit: true });
                    return;
                }
                const current = this._normalizedCharacterTransform(this.activeCharacterAppearance?.transform);
                const factor = 1.0 - Math.sign(delta) * Math.min(0.004 * absDelta, 0.075);
                const transform = {
                    ...current,
                    zoom: Math.max(0.1, Math.min(7, current.zoom * factor)),
                };
                this.setActiveCharacterAppearance({ transform });
                this.options.onCharacterTransformChange?.(transform);
                return;
            }
            const scale = 1.0 + Math.sign(delta) * Math.min(0.004 * absDelta, 0.075);
            this.zoomViewAtPointer(e, scale);
            this.requestRender();
        };
        this.canvas.addEventListener('wheel', this._handleViewportWheel, { passive: false, capture: true });

        // Render on demand: orbit change triggers render
        this.orbit.addEventListener('change', () => this.requestRender());

        // Transform Controls (Gizmo)
        this.transform = new this.TransformControls(this.camera, this.canvas);
        this.transform.setMode("rotate");
        this.transform.setSpace("local");
        this.transform.setSize(0.4);
        this.scene.add(this.transform);
        this._createCharacterRotationGuide();

        this.transform.addEventListener("dragging-changed", (e) => {
            this.orbit.enabled = !e.value;

            if (e.value) {
                // Drag Started: Record state for Undo
                this.recordState();
            } else {
                // Drag Ended
                // If dragging an IK effector, do final IK solve
                if (this.selectedIKEffector && this.transform.mode === 'translate') {
                    this.solveIKForEffector();
                }

                // If FK manipulation ended, update effector positions to follow bones
                if (this.transform.mode === 'rotate' && !this.selectedIKEffector) {
                    this.updateIKEffectorPositions();
                }

                // Sync to node
                this.isInteractionActive = false;
                if (this.options.onInteractionEnd) {
                    this.options.onInteractionEnd({ type: this.selectedIKEffector ? 'ik' : 'fk' });
                }
                this.dispatchPoseChange();
            }
        });

        // Real-time IK solving during drag - use 'objectChange' event
        this.transform.addEventListener('objectChange', () => {
            // Real-time IK solving during effector drag
            if (this.selectedIKEffector) {
                this.solveIKForEffector();
                // Update other (non-selected) effectors to follow their bones during IK
                this.updateIKEffectorPositions('nonSelected');
            } else if (this.selectedPoleTarget) {
                // Pole target moved - solve IK for this chain
                this.solveIKForPoleTarget();
            } else if (this.selectedBone) {
                // FK rotation - update all effector positions to follow bones
                this.updateIKEffectorPositions();
            }
            this.requestRender();
        });

        // Render on demand: transform change triggers render
        this.transform.addEventListener('change', () => this.requestRender());

        // Soft studio lighting keeps the mannequin readable while preserving
        // shape through gentle key, fill, and rim separation. These are fixed
        // presentation lights rather than user-facing pose controls.
        this.scene.add(new THREE.HemisphereLight(0xf2f6ff, 0x8f786c, 1.15));
        const keyLight = new THREE.DirectionalLight(0xffeadb, 1.65);
        keyLight.position.set(-7, 10, 12);
        this.scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0xd8e8ff, 0.7);
        fillLight.position.set(8, 4, 8);
        this.scene.add(fillLight);
        const rimLight = new THREE.DirectionalLight(0xfff1df, 0.85);
        rimLight.position.set(2, 8, -9);
        this.scene.add(rimLight);

        // Capture Camera (Independent of Orbit camera)
        this.captureCamera = new THREE.PerspectiveCamera(
            POSE_STUDIO_CAPTURE_FOV,
            this.width / this.height,
            0.1,
            500,
        );
        this.scene.add(this.captureCamera);
        // The common scene camera must not jump when a differently shaped
        // active character replaces the editor rig.
        this.sceneCameraTarget = null;

        // Visual Helper - Gray Capture Frame
        const frameGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-1, 1, 0), new THREE.Vector3(1, 1, 0),
            new THREE.Vector3(1, -1, 0), new THREE.Vector3(-1, -1, 0),
            new THREE.Vector3(-1, 1, 0)
        ]);
        this.captureFrame = new THREE.Line(frameGeo, new THREE.LineBasicMaterial({ color: 0x888888, linewidth: 2 }));
        this.scene.add(this.captureFrame);
        this.captureFrame.visible = false;

        const frameGridPoints = [];
        const frameGridDivisions = 14;
        for (let division = 1; division < frameGridDivisions; division += 1) {
            const t = -1 + 2 * division / frameGridDivisions;
            frameGridPoints.push(
                new THREE.Vector3(t, -1, 0.002),
                new THREE.Vector3(t, 1, 0.002),
                new THREE.Vector3(-1, t, 0.002),
                new THREE.Vector3(1, t, 0.002),
            );
        }
        const frameGridGeo = new THREE.BufferGeometry().setFromPoints(frameGridPoints);
        this.captureFrameGrid = new THREE.LineSegments(frameGridGeo, new THREE.LineBasicMaterial({
            color: 0x9aabd4, transparent: true, opacity: 0.34,
        }));
        this.captureFrameGrid.renderOrder = 2;
        this.scene.add(this.captureFrameGrid);
        this.captureFrameGrid.visible = false;

        // Extend the floor forward from the frame's bottom edge, toward the
        // viewing camera, while keeping the space behind the frame clear.
        // The depth is scaled with the frame's half-height below, so a local
        // depth of two produces a ground extension about one frame-height long.
        const horizonDepth = 2;
        const horizonGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, -1, 0),
            new THREE.Vector3(1, -1, horizonDepth), new THREE.Vector3(-1, -1, horizonDepth),
        ]);
        horizonGeo.setIndex([0, 1, 2, 0, 2, 3]);
        this.captureHorizon = new THREE.Mesh(horizonGeo, new THREE.MeshBasicMaterial({
            color: 0x7183ad, transparent: true, opacity: 0.035,
            side: THREE.DoubleSide, depthWrite: false,
        }));
        this.scene.add(this.captureHorizon);
        this.captureHorizon.visible = false;
        const horizonGridPoints = [];
        const acrossDivisions = frameGridDivisions;
        const depthDivisions = frameGridDivisions;
        for (let across = 0; across <= acrossDivisions; across += 1) {
            const x = -1 + 2 * across / acrossDivisions;
            horizonGridPoints.push(
                new THREE.Vector3(x, -1, 0),
                new THREE.Vector3(x, -1, horizonDepth),
            );
        }
        for (let step = 1; step <= depthDivisions; step += 1) {
            const t = step / depthDivisions;
            horizonGridPoints.push(
                new THREE.Vector3(-1, -1, horizonDepth * t),
                new THREE.Vector3(1, -1, horizonDepth * t),
            );
        }
        const horizonGridGeo = new THREE.BufferGeometry().setFromPoints(horizonGridPoints);
        this.captureHorizonGrid = new THREE.LineSegments(horizonGridGeo, new THREE.LineBasicMaterial({
            color: 0x9aabd4, transparent: true, opacity: 0.38,
        }));
        this.captureHorizonGrid.renderOrder = 2;
        this.scene.add(this.captureHorizonGrid);
        this.captureHorizonGrid.visible = false;
        const horizonBoundaryGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, -1, 0),
        ]);
        this.captureHorizonBoundary = new THREE.Line(horizonBoundaryGeo, new THREE.LineBasicMaterial({
            color: 0x70d9ff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false,
        }));
        this.captureHorizonBoundary.renderOrder = 10;
        this.scene.add(this.captureHorizonBoundary);
        this.captureHorizonBoundary.visible = false;

        // Events
        this.canvas.addEventListener("pointerdown", (e) => this.handlePointerDown(e));
        this.canvas.addEventListener("pointermove", (e) => this.schedulePointerMove(e));
        this.canvas.addEventListener("pointerup", (e) => this.handlePointerUp(e));
        this.canvas.addEventListener("pointercancel", (e) => this.handlePointerUp(e, { cancelled: true }));
        this.canvas.addEventListener("lostpointercapture", (e) => this.handlePointerUp(e, { cancelled: true }));

        this.hoveredBoneName = null;
        this.directDrag = { active: false, chainKey: null, effector: null, effectorBone: null, plane: null, offset: null, hasDragged: false, clickedBone: null, startClientX: 0, startClientY: 0 };
    }

    animate() {
        this._renderFrame = null;
        if (!this.initialized) return;

        // Damping requires continuous updates while active
        const dampingChanged = this.orbit?.enableDamping ? this.orbit.update() : false;

        if (this._needsRender || dampingChanged) {
            this._needsRender = false;
            if (this.renderer) {
                this.renderer.render(this.scene, this.camera);
                this._updateCharacterRotationGuide();
                this.options.onViewportRender?.();
            }
        }

        if (dampingChanged) this.requestRender();
    }

    requestRender() {
        this._needsRender = true;
        if (!this.initialized || this._renderFrame) return;
        this._renderFrame = requestAnimationFrame(() => this.animate());
    }

    viewportVisibleHeight(distance = this.camera.position.distanceTo(this.orbit.target)) {
        return this.camera.isOrthographicCamera
            ? (this.camera.top - this.camera.bottom) / this.camera.zoom
            : 2 * distance * Math.tan(this.THREE.MathUtils.degToRad(this.camera.fov / 2)) / this.camera.zoom;
    }

    setViewportProjection(mode) {
        if (!this.camera || !this.orbit) return false;
        const parallel = mode === "parallel";
        if (!!this.camera.isOrthographicCamera === parallel) return true;
        this.finishCharacterControlDrag?.();
        const previous = this.camera;
        const distance = Math.max(0.001, previous.position.distanceTo(this.orbit.target));
        const height = this.viewportVisibleHeight(distance);
        const aspect = previous.aspect;
        const fov = previous.fov || 45;
        const camera = parallel
            ? new this.THREE.OrthographicCamera(-height * aspect / 2, height * aspect / 2, height / 2, -height / 2, previous.near, previous.far)
            : new this.THREE.PerspectiveCamera(fov, aspect, previous.near, previous.far);
        camera.aspect = aspect;
        camera.fov = fov;
        camera.position.copy(previous.position);
        camera.quaternion.copy(previous.quaternion);
        camera.up.copy(previous.up);
        if (!parallel) camera.zoom = 2 * distance * Math.tan(this.THREE.MathUtils.degToRad(fov / 2)) / height;
        for (const child of [...previous.children]) camera.add(child);
        previous.parent?.remove(previous);
        this.scene.add(camera);
        this.camera = camera;
        this.orbit.object = camera;
        if (this.transform) this.transform.camera = camera;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        this.orbit.update();
        this.requestRender();
        return true;
    }

    scaleViewport(scale) {
        if (this.camera.isOrthographicCamera) {
            this.camera.zoom = Math.max(0.001, Math.min(1000, this.camera.zoom / scale));
            this.camera.updateProjectionMatrix();
        } else {
            this.camera.position.sub(this.orbit.target).multiplyScalar(scale).add(this.orbit.target);
        }
    }

    zoomViewAtPointer(event, scale) {
        const rect = this.canvas?.getBoundingClientRect?.();
        if (!rect?.width || !rect?.height || !this.camera || !this.orbit) return;

        const pointer = new this.THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            1 - ((event.clientY - rect.top) / rect.height) * 2,
        );
        const viewDirection = this.camera.getWorldDirection(new this.THREE.Vector3()).normalize();
        const zoomPlane = new this.THREE.Plane().setFromNormalAndCoplanarPoint(
            viewDirection,
            this.orbit.target,
        );
        const anchorBefore = new this.THREE.Vector3();
        this._raycaster.setFromCamera(pointer, this.camera);
        if (!this._raycaster.ray.intersectPlane(zoomPlane, anchorBefore)) {
            this.scaleViewport(scale);
            this.orbit.update();
            return;
        }

        this.scaleViewport(scale);
        this.camera.updateMatrixWorld(true);
        this._raycaster.setFromCamera(pointer, this.camera);
        const anchorAfter = new this.THREE.Vector3();
        if (this._raycaster.ray.intersectPlane(zoomPlane, anchorAfter)) {
            const panOffset = anchorBefore.sub(anchorAfter);
            this.camera.position.add(panOffset);
            this.orbit.target.add(panOffset);
        }
        this.orbit.update();
    }

    _createCharacterRotationGuide() {
        const parent = this.canvas?.parentElement;
        if (!parent || typeof document === "undefined") return;
        const namespace = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(namespace, "svg");
        svg.setAttribute("aria-hidden", "true");
        Object.assign(svg.style, {
            position: "absolute",
            inset: "0",
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: "4",
            overflow: "hidden",
        });
        const circle = document.createElementNS(namespace, "circle");
        circle.setAttribute("fill", "none");
        circle.setAttribute("stroke", this._rotationGuideActive ? "#ffd43b" : "#ff343d");
        circle.setAttribute("stroke-width", "4");
        circle.setAttribute("vector-effect", "non-scaling-stroke");
        circle.setAttribute("opacity", "0.96");
        circle.style.display = "none";
        svg.appendChild(circle);
        const axisGizmo = document.createElementNS(namespace, "g");
        axisGizmo.setAttribute("class", "vnccs-pose-world-axis-gizmo");
        axisGizmo.setAttribute("aria-hidden", "true");
        svg.appendChild(axisGizmo);
        parent.appendChild(svg);
        this._rotationGuideSvg = svg;
        this._rotationGuideCircle = circle;
        this._characterAxisGizmo = axisGizmo;
        axisGizmo.style.pointerEvents = "none";
        this._jointLockPointerDown = event => {
            if (event.button !== 0) return;
            this._jointLockPress = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
        };
        this._jointLockPointerMove = event => {
            const press = this._jointLockPress;
            if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) press.moved = true;
        };
        this._jointLockPointerUp = event => {
            const press = this._jointLockPress;
            if (!press || press.id !== event.pointerId) return;
            this._jointLockPress = null;
            if (event.button !== 0 || press.moved) return;
            const bone = this._getLockableBoneAtPointer(event);
            if (!bone && this.pickCharacterAtPointer(event)) {
                this._jointLockClick = null;
                return;
            }
            const previous = this._jointLockClick;
            const now = performance.now();
            const isDouble = previous && previous.boneName === (bone?.name || null)
                && now - previous.time <= 420
                && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 26;
            if (!isDouble) {
                this._jointLockClick = { boneName: bone?.name || null, time: now, x: event.clientX, y: event.clientY };
                return;
            }
            this._jointLockClick = null;
            if (bone) {
                this._lockedBoneName = null;
                this.selectBone(bone);
                this._lockedBoneName = bone.name;
                this.requestRender();
            } else {
                this._lockedBoneName = null;
                this.deselectBone();
            }
        };
        window.addEventListener("pointerdown", this._jointLockPointerDown, true);
        window.addEventListener("pointermove", this._jointLockPointerMove, true);
        window.addEventListener("pointerup", this._jointLockPointerUp, true);
        window.addEventListener("pointercancel", this._jointLockPointerUp, true);
        this._axisRightPressMove = event => {
            const pending = this._axisRightPress;
            if (!pending || pending.pointerId !== event.pointerId) return;
            if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 5) pending.moved = true;
        };
        this._axisRightPressEnd = event => {
            const pending = this._axisRightPress;
            if (!pending || pending.pointerId !== event.pointerId) return;
            this._axisRightPress = null;
            if (!pending.moved) {
                this._temporaryAxisOrientation = this.camera.getWorldQuaternion(new this.THREE.Quaternion());
                this._characterAxisHovered = null;
                this._updateCharacterRotationGuide();
            }
        };
        window.addEventListener("pointermove", this._axisRightPressMove, true);
        window.addEventListener("pointerup", this._axisRightPressEnd, true);
        window.addEventListener("pointercancel", this._axisRightPressEnd, true);
        // The interactive SVG captures pointer hits for the axis arrows, so
        // forward wheel zoom through the same handler used by the canvas.
        svg.addEventListener("wheel", event => this._handleViewportWheel?.(event), { passive: false, capture: true });
        svg.addEventListener("pointerdown", event => this._beginCharacterAxisDrag(event), true);
        svg.addEventListener("contextmenu", event => event.preventDefault());
        svg.addEventListener("pointermove", event => this._moveCharacterAxisDrag(event), true);
        svg.addEventListener("pointerup", event => this._finishCharacterAxisDrag(event), true);
        svg.addEventListener("pointercancel", event => this._finishCharacterAxisDrag(event), true);
        svg.addEventListener("pointerleave", () => {
            if (this._characterAxisHovered) {
                this._characterAxisHovered = null;
                this._updateCharacterRotationGuide();
            }
        });
        this._refreshCharacterRotationGuideStyle();
        this._updateCharacterRotationGuide();
    }

    _getViewRotationPivot() {
        if (!this._noCharacterSelection && !this._multiCharacterSelection && this.skinnedMesh) {
            return this.skinnedMesh.getWorldPosition(new this.THREE.Vector3());
        }
        // With no active character selection, orbit the centre of the whole
        // cast by averaging each visible character's XYZ origin.
        if (this.THREE) {
            const characters = [];
            if (this.skinnedMesh?.visible) characters.push(this.skinnedMesh);
            for (const entry of this.passiveCharacters?.values?.() || []) {
                if (entry?.mesh?.visible) characters.push(entry.mesh);
            }
            if (characters.length) {
                const pivot = new this.THREE.Vector3();
                for (const mesh of characters) {
                    mesh.updateWorldMatrix?.(true, false);
                    pivot.add(mesh.getWorldPosition(new this.THREE.Vector3()));
                }
                return pivot.multiplyScalar(1 / characters.length);
            }
        }
        return this._getFrameGroundOrigin();
    }

    _getFrameGroundOrigin() {
        if (this.captureFrame && this.THREE) {
            this.captureFrame.updateMatrixWorld(true);
            return this.captureFrame.localToWorld(new this.THREE.Vector3(0, -1, 0));
        }
        return (this.sceneCameraTarget || this.orbit?.target || new this.THREE.Vector3()).clone();
    }

    getGroundAlignedCharacterY(zoom = 1) {
        const mesh = this.skinnedMesh;
        const position = mesh?.geometry?.attributes?.position;
        if (!mesh || !position || !this.THREE || position.count < 1) return null;
        mesh.updateMatrixWorld(true);
        this.skeleton?.update?.();
        const point = new this.THREE.Vector3();
        let minWorldY = Infinity;
        for (let index = 0; index < position.count; index += 1) {
            point.fromBufferAttribute(position, index);
            if (typeof mesh.applyBoneTransform === "function") mesh.applyBoneTransform(index, point);
            point.applyMatrix4(mesh.matrixWorld);
            if (Number.isFinite(point.y)) minWorldY = Math.min(minWorldY, point.y);
        }
        if (!Number.isFinite(minWorldY)) return null;
        const currentZoom = Math.max(1e-6, mesh.scale.y);
        const localFootY = (minWorldY - mesh.position.y) / currentZoom;
        const requestedZoom = Math.max(0.1, Number(zoom) || 1);
        return this._getFrameGroundOrigin().y - localFootY * requestedZoom;
    }

    getFrameCenteredCharacterY(zoom = 1) {
        const mesh = this.skinnedMesh;
        const position = mesh?.geometry?.attributes?.position;
        if (!mesh || !position || !this.THREE || position.count < 1) return null;
        mesh.updateMatrixWorld(true);
        this.skeleton?.update?.();
        const point = new this.THREE.Vector3();
        let minWorldY = Infinity;
        let maxWorldY = -Infinity;
        for (let index = 0; index < position.count; index += 1) {
            point.fromBufferAttribute(position, index);
            if (typeof mesh.applyBoneTransform === "function") mesh.applyBoneTransform(index, point);
            point.applyMatrix4(mesh.matrixWorld);
            if (!Number.isFinite(point.y)) continue;
            minWorldY = Math.min(minWorldY, point.y);
            maxWorldY = Math.max(maxWorldY, point.y);
        }
        if (!Number.isFinite(minWorldY) || !Number.isFinite(maxWorldY)) return null;
        const currentZoom = Math.max(1e-6, mesh.scale.y);
        const localCenterY = ((minWorldY + maxWorldY) * 0.5 - mesh.position.y) / currentZoom;
        const requestedZoom = Math.max(0.1, Number(zoom) || 1);
        const frameCenterY = this.captureFrame?.getWorldPosition?.(new this.THREE.Vector3())?.y
            ?? this.sceneCameraTarget?.y
            ?? this.orbit?.target?.y
            ?? 0;
        return frameCenterY - localCenterY * requestedZoom;
    }

    getBackAlignedCharacterZ(zoom = 1) {
        const mesh = this.skinnedMesh;
        const position = mesh?.geometry?.attributes?.position;
        if (!mesh || !position || !this.THREE || position.count < 1) return null;
        mesh.updateMatrixWorld(true);
        this.skeleton?.update?.();
        const point = new this.THREE.Vector3();
        let minWorldZ = Infinity;
        for (let index = 0; index < position.count; index += 1) {
            point.fromBufferAttribute(position, index);
            if (typeof mesh.applyBoneTransform === "function") mesh.applyBoneTransform(index, point);
            point.applyMatrix4(mesh.matrixWorld);
            if (Number.isFinite(point.z)) minWorldZ = Math.min(minWorldZ, point.z);
        }
        if (!Number.isFinite(minWorldZ)) return null;
        const currentZoom = Math.max(1e-6, mesh.scale.z);
        const localBackZ = (minWorldZ - mesh.position.z) / currentZoom;
        const requestedZoom = Math.max(0.1, Number(zoom) || 1);
        // Keep the furthest rearward vertex just in front of the frame plane
        // to avoid precision errors making a toe or fingertip fade behind it.
        return this._getFrameGroundOrigin().z - localBackZ * requestedZoom + 0.01 * requestedZoom;
    }

    _drawCharacterAxisGizmo(origin, rect, centerX, centerY, { interactive = true, orientation = null } = {}) {
        const group = this._characterAxisGizmo;
        if (!group || !this.camera || !rect?.height) return;
        // Visible coordinate handles support direct pointer interaction.
        group.style.pointerEvents = interactive ? "all" : "none";
        const THREE = this.THREE;
        const distance = this.camera.position.distanceTo(origin);
        const visibleHeight = this.camera.isOrthographicCamera
            ? (this.camera.top - this.camera.bottom) / this.camera.zoom
            : 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / this.camera.zoom;
        const worldLength = visibleHeight / rect.height * 82;
        const characterRotation = orientation || this.skinnedMesh?.getWorldQuaternion?.(new THREE.Quaternion())
            || new THREE.Quaternion();
        // Editor convention: X is horizontal, Y is depth, and Z is vertical.
        // Three.js keeps its Y-up scene internally, so map the editor basis here.
        const axes = [
            { name: "X", color: "#ff3030", vector: editorAxisVector(THREE, "X").applyQuaternion(characterRotation).normalize() },
            { name: "Y", color: "#35d05b", vector: editorAxisVector(THREE, "Y").applyQuaternion(characterRotation).normalize() },
            { name: "Z", color: "#328cff", vector: editorAxisVector(THREE, "Z").applyQuaternion(characterRotation).normalize() },
        ];
        const screenPoint = point => {
            const projected = point.project(this.camera);
            return {
                x: (projected.x + 1) * rect.width * 0.5,
                y: (1 - projected.y) * rect.height * 0.5,
            };
        };
        const center = { x: centerX, y: centerY };
        const projectedAxes = axes.map(axis => ({
            ...axis,
            point: screenPoint(origin.clone().addScaledVector(axis.vector, worldLength)),
        }));
        group.replaceChildren();

        // Three rounded quarter-arcs join each pair of editor axes. Dragging
        // an arc rotates the character around the remaining axis (XY -> Z,
        // YZ -> X, ZX -> Y), like the curved edges of a 3D rotation gizmo.
        const axisByName = new Map(axes.map(axis => [axis.name, axis]));
        const rotationArcRadius = worldLength * 0.82;
        const rotationArcs = [
            { from: "X", to: "Y", axis: "Z", plane: "XY" },
            { from: "Y", to: "Z", axis: "X", plane: "YZ" },
            { from: "Z", to: "X", axis: "Y", plane: "ZX" },
        ];
        this._characterAxisArcHitSegments = [];
        this._characterAxisPlaneHitRegions = [];
        const planeHitElements = [];
        const rotationHitElements = [];
        for (const arc of rotationArcs) {
            const from = axisByName.get(arc.from)?.vector;
            const to = axisByName.get(arc.to)?.vector;
            if (!from || !to) continue;
            const points = [];
            const segments = 24;
            for (let index = 0; index <= segments; index += 1) {
                const angle = (Math.PI * 0.5 * index) / segments;
                const point = origin.clone()
                    .addScaledVector(from, Math.cos(angle) * rotationArcRadius)
                    .addScaledVector(to, Math.sin(angle) * rotationArcRadius);
                points.push(screenPoint(point));
            }
            for (let index = 1; index < points.length; index += 1) {
                this._characterAxisArcHitSegments.push({
                    axis: arc.axis,
                    start: points[index - 1],
                    end: points[index],
                });
            }
            // Use the visible arc itself as the boundary for both the plane
            // hit region and its hover fill.
            const planeDragPoints = points;
            const planeEnabled = !this.selectedBone || this.selectedBone.name === this._centerHipBoneName;
            if (planeEnabled) this._characterAxisPlaneHitRegions.push({ plane: arc.plane, points: [center, ...planeDragPoints] });
            const pathData = points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
            if (interactive) {
                const planePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
                planePath.setAttribute("d", ["M " + center.x + " " + center.y, ...planeDragPoints.map(point => "L " + point.x + " " + point.y), "Z"].join(" "));
                planePath.setAttribute("fill", planeEnabled && this._characterAxisHovered === "plane:" + arc.plane ? "rgba(0, 229, 255, 0.4)" : "transparent");
                planePath.setAttribute("stroke", "none");
                planePath.setAttribute("pointer-events", "fill");
                if (planeEnabled) planePath.dataset.plane = arc.plane;
                else planePath.dataset.rightClickPlane = arc.plane;
                planePath.style.cursor = !planeEnabled ? "default" : this._characterAxisDrag?.planeName === arc.plane ? "grabbing" : "grab";
                planePath.setAttribute("title", planeEnabled ? "左键拖动 " + arc.plane + " 平面移动" : "右键对齐屏幕坐标");
                planeHitElements.push(planePath);
            }
            const isEmphasized = interactive && (
                this._characterAxisHovered === `rotation:${arc.axis}`
                || this._characterAxisDrag?.rotationAxisName === arc.axis
            );
            if (interactive) {
                const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
                hitPath.setAttribute("d", pathData);
                hitPath.setAttribute("fill", "none");
                hitPath.setAttribute("stroke", "transparent");
                hitPath.setAttribute("stroke-width", "12");
                hitPath.setAttribute("stroke-linecap", "round");
                hitPath.setAttribute("stroke-linejoin", "round");
                hitPath.setAttribute("pointer-events", "stroke");
                hitPath.dataset.rotationAxis = arc.axis;
                hitPath.style.cursor = this._characterAxisDrag?.rotationAxisName === arc.axis ? "grabbing" : "grab";
                hitPath.setAttribute("title", `左键拖动 ${arc.from}${arc.to} 平面，绕 ${arc.axis} 轴旋转`);
                rotationHitElements.push(hitPath);
            }
            const visiblePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
            visiblePath.setAttribute("d", pathData);
            visiblePath.setAttribute("fill", "none");
            visiblePath.setAttribute("stroke", isEmphasized ? "#00e5ff" : (axisByName.get(arc.axis)?.color || "#8fa7c2"));
            visiblePath.setAttribute("stroke-width", "2");
            visiblePath.setAttribute("stroke-linecap", "round");
            visiblePath.setAttribute("stroke-linejoin", "round");
            visiblePath.setAttribute("vector-effect", "non-scaling-stroke");
            visiblePath.style.pointerEvents = "none";
            group.appendChild(visiblePath);
        }

        group.append(...planeHitElements, ...rotationHitElements);
        const jointAxesDisabled = this.selectedBone && this.selectedBone.name !== this._centerHipBoneName;
        for (const axis of projectedAxes) {
            const isEmphasized = interactive && !jointAxesDisabled && (this._characterAxisHovered === axis.name || this._characterAxisDrag?.axisName === axis.name);
            const axisColor = jointAxesDisabled ? "#888888" : axis.color;
            if (interactive) {
                const hitLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
                hitLine.setAttribute("x1", String(center.x));
                hitLine.setAttribute("y1", String(center.y));
                hitLine.setAttribute("x2", String(axis.point.x));
                hitLine.setAttribute("y2", String(axis.point.y));
                hitLine.setAttribute("stroke", "transparent");
                hitLine.setAttribute("stroke-width", "12");
                hitLine.setAttribute("pointer-events", "stroke");
                hitLine.dataset.axis = axis.name;
                hitLine.style.cursor = jointAxesDisabled ? "default" : this._characterAxisDrag?.axisName === axis.name
                    ? "grabbing"
                    : "grab";
                hitLine.setAttribute("title", `左键拖动 ${axis.name} 轴`);
                group.appendChild(hitLine);
            }

            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", String(center.x));
            line.setAttribute("y1", String(center.y));
            line.setAttribute("x2", String(axis.point.x));
            line.setAttribute("y2", String(axis.point.y));
            line.setAttribute("stroke", isEmphasized ? "#00e5ff" : axisColor);
            line.setAttribute("stroke-width", "2");
            line.setAttribute("stroke-linecap", "round");
            line.setAttribute("vector-effect", "non-scaling-stroke");
            line.style.pointerEvents = "none";
            group.appendChild(line);

            const dx = axis.point.x - center.x;
            const dy = axis.point.y - center.y;
            const length = Math.hypot(dx, dy);
            if (length > 8) {
                const ux = dx / length;
                const uy = dy / length;
                const headSize = 9;
                const baseX = axis.point.x - ux * headSize;
                const baseY = axis.point.y - uy * headSize;
                const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
                arrow.setAttribute("d", `M ${baseX - uy * headSize * 0.75} ${baseY + ux * headSize * 0.75} L ${axis.point.x} ${axis.point.y} L ${baseX + uy * headSize * 0.75} ${baseY - ux * headSize * 0.75}`);
                arrow.setAttribute("fill", "none");
                arrow.setAttribute("stroke", isEmphasized ? "#00e5ff" : axisColor);
                arrow.setAttribute("stroke-width", "2");
                arrow.setAttribute("stroke-linecap", "round");
                arrow.setAttribute("stroke-linejoin", "round");
                arrow.style.pointerEvents = "none";
                group.appendChild(arrow);
            }

        }
    }

    _pickCharacterAxisGizmoHit(event) {
        const target = event.target;
        const rect = this.canvas?.getBoundingClientRect?.();
        if (!rect || event.ctrlKey) return { axisName: null, rotationAxisName: null };
        if (target?.dataset?.rightClickPlane) return { axisName: null, rotationAxisName: null };
        if (target?.dataset?.axis) return {
            axisName: this.selectedBone && this.selectedBone.name !== this._centerHipBoneName ? null : target.dataset.axis,
            rotationAxisName: null,
        };
        if (target?.dataset?.rotationAxis) return { axisName: null, rotationAxisName: target.dataset.rotationAxis };
        const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        let closest = null;
        for (const segment of this._characterAxisArcHitSegments || []) {
            const dx = segment.end.x - segment.start.x;
            const dy = segment.end.y - segment.start.y;
            const lengthSq = dx * dx + dy * dy;
            const t = lengthSq > 0
                ? Math.max(0, Math.min(1, ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / lengthSq))
                : 0;
            const distance = Math.hypot(
                point.x - (segment.start.x + t * dx),
                point.y - (segment.start.y + t * dy),
            );
            if (distance <= 6 && (!closest || distance < closest.distance)) {
                closest = { rotationAxisName: segment.axis, distance };
            }
        }
        if (closest) return { axisName: null, rotationAxisName: closest.rotationAxisName };
        // Edge-on arcs used to capture a broad band across the adjacent fan.
        // Keep their hits close to the visible line, and choose the most
        // face-on plane when projected plane regions overlap.
        const planes = (this._characterAxisPlaneHitRegions || [])
            .filter(region => this._isPointInPolygon(point, region.points))
            .map(region => ({ ...region, area: Math.abs(region.points.reduce((sum, a, index, points) => {
                const b = points[(index + 1) % points.length];
                return sum + a.x * b.y - b.x * a.y;
            }, 0)) }));
        planes.sort((a, b) => b.area - a.area);
        const planeName = planes[0]?.plane || target?.dataset?.plane || null;
        return { axisName: null, rotationAxisName: null, planeName };
    }

    _isPointInPolygon(point, polygon) {
        if (!Array.isArray(polygon) || polygon.length < 3) return false;
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
            const a = polygon[i];
            const b = polygon[j];
            const crosses = (a.y > point.y) !== (b.y > point.y)
                && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 1e-9) + a.x;
            if (crosses) inside = !inside;
        }
        return inside;
    }

    _beginCharacterAxisDrag(event) {
        if (event.ctrlKey) {
            this._characterAxisHovered = null;
            this._updateCharacterRotationGuide();
            this.beginCharacterControlDrag(event);
            return;
        }
        if (event.button === 2) {
            this._axisRightPress = {
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                moved: false,
            };
            const forwarded = new PointerEvent("pointerdown", {
                bubbles: true, cancelable: true, pointerId: event.pointerId,
                pointerType: event.pointerType, isPrimary: event.isPrimary,
                clientX: event.clientX, clientY: event.clientY,
                screenX: event.screenX, screenY: event.screenY,
                button: event.button, buttons: event.buttons, ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
            });
            this.canvas.dispatchEvent(forwarded);
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (event.button === 0 && (event.target?.dataset?.rightClickPlane || this._getJointMarkerAtPointer(event))) {
            const forwarded = new PointerEvent("pointerdown", {
                bubbles: true, cancelable: true, pointerId: event.pointerId,
                pointerType: event.pointerType, isPrimary: event.isPrimary,
                clientX: event.clientX, clientY: event.clientY,
                screenX: event.screenX, screenY: event.screenY,
                button: event.button, buttons: event.buttons, ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
            });
            this.canvas.dispatchEvent(forwarded);
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        const { axisName, rotationAxisName, planeName } = this._pickCharacterAxisGizmoHit(event);
        if (!axisName && !rotationAxisName && !planeName) return;
        if (event.button === 2) {
            // Forward right-button gestures to the normal viewport controls.
            const forwarded = new PointerEvent("pointerdown", {
                bubbles: true,
                cancelable: true,
                pointerId: event.pointerId,
                pointerType: event.pointerType,
                isPrimary: event.isPrimary,
                clientX: event.clientX,
                clientY: event.clientY,
                screenX: event.screenX,
                screenY: event.screenY,
                button: event.button,
                buttons: event.buttons,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
            });
            this.canvas.dispatchEvent(forwarded);
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (event.button !== 0) return;
        if (!this.skinnedMesh || !this.camera) return;
        const planeAxes = planeName === "XY" ? ["X", "Y"] : planeName === "YZ" ? ["Y", "Z"] : planeName === "ZX" ? ["Z", "X"] : null;
        const normalAxisName = rotationAxisName || axisName || (planeName === "XY" ? "Z" : planeName === "YZ" ? "X" : "Y");
        const axisDef = POSE_STUDIO_EDITOR_AXES[normalAxisName];
        if (!axisDef) return;
        const THREE = this.THREE;
        const rect = this.canvas?.getBoundingClientRect?.();
        if (!rect?.width || !rect?.height) return;
        const pointer = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        this.skinnedMesh.updateMatrixWorld(true);
        const targetBone = this.selectedBone || null;
        const characterOrientation = this._temporaryAxisOrientation?.clone()
            || (targetBone || this.skinnedMesh).getWorldQuaternion(new THREE.Quaternion());
        const axis = editorAxisVector(THREE, normalAxisName).applyQuaternion(characterOrientation).normalize();
        const planeBasis = planeAxes?.map(name => editorAxisVector(THREE, name).applyQuaternion(characterOrientation).normalize()) || null;
        const hip = this.bones?.[this._centerHipBoneName]
            || this.boneList?.find(bone => bone.name === this._centerHipBoneName);
        const origin = (targetBone || hip)?.getWorldPosition(new THREE.Vector3())
            || this.skinnedMesh.getWorldPosition(new THREE.Vector3());
        const viewDirection = this.camera.getWorldDirection(new THREE.Vector3());
        const planeNormal = (rotationAxisName || planeName)
            ? axis.clone()
            : viewDirection.clone().addScaledVector(axis, -viewDirection.dot(axis));
        if (planeNormal.lengthSq() < 1e-8) return;
        planeNormal.normalize();
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(pointer, this.camera);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, origin);
        const startPoint = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
        if (!startPoint) return;
        if (rotationAxisName && startPoint.distanceTo(origin) < 1e-5) return;
        const startTransform = this._normalizedCharacterTransform(this.activeCharacterAppearance?.transform);
        const startObjectPosition = rotationAxisName
            ? this.skinnedMesh.getWorldPosition(new THREE.Vector3())
            : null;
        const startObjectQuaternion = rotationAxisName
            ? this.skinnedMesh.getWorldQuaternion(new THREE.Quaternion())
            : null;
        this._characterAxisDrag = {
            targetBone,
            startBonePosition: targetBone?.getWorldPosition(new THREE.Vector3()),
            startBoneQuaternion: targetBone?.getWorldQuaternion(new THREE.Quaternion()),
            pointerId: event.pointerId,
            axis,
            plane,
            origin,
            startPoint,
            startMeshPosition: this.skinnedMesh.position.clone(),
            parentWorldQuaternion: this.skinnedMesh.parent?.getWorldQuaternion(new THREE.Quaternion()) || new THREE.Quaternion(),
            axisName,
            rotationAxisName,
            planeName,
            planeBasis,
            startTransform,
            rotationPivot: rotationAxisName ? origin.clone() : null,
            startObjectPosition,
            startObjectQuaternion,
            startPointerVector: rotationAxisName ? startPoint.clone().sub(origin).normalize() : null,
        };
        this._rotationGuideSvg?.setPointerCapture?.(event.pointerId);
        event.target.style.cursor = "grabbing";
        if (targetBone || rotationAxisName || planeName) this.recordState();
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    _moveCharacterAxisDrag(event) {
        const drag = this._characterAxisDrag;
        if (!drag) {
            const markerHit = this._getJointMarkerAtPointer(event);
            const hoveredBoneName = markerHit ? this.boneList?.[markerHit.object.userData?.boneIndex]?.name || null : null;
            if (this.hoveredBoneName !== hoveredBoneName) {
                this.hoveredBoneName = hoveredBoneName;
                this.updateMarkers();
                this.requestRender();
            }
            const hit = this._pickCharacterAxisGizmoHit(event);
            const hoveredAxis = hit.rotationAxisName ? `rotation:${hit.rotationAxisName}`
                : hit.planeName ? `plane:${hit.planeName}` : hit.axisName;
            if (hoveredAxis !== this._characterAxisHovered) {
                this._characterAxisHovered = hoveredAxis;
                this._updateCharacterRotationGuide();
            }
            return;
        }
        if (event.pointerId !== drag.pointerId) return;
        const THREE = this.THREE;
        const rect = this.canvas?.getBoundingClientRect?.();
        if (!rect?.width || !rect?.height) return;
        const pointer = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(pointer, this.camera);
        const point = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
        if (!point) return;
        if (drag.targetBone) {
            const bone = drag.targetBone;
            if (drag.rotationAxisName) {
                const current = point.sub(drag.origin).normalize();
                if (current.lengthSq() < 1e-8) return;
                const angle = Math.atan2(new THREE.Vector3().crossVectors(drag.startPointerVector, current).dot(drag.axis), drag.startPointerVector.dot(current));
                const worldRotation = new THREE.Quaternion().setFromAxisAngle(drag.axis, angle).multiply(drag.startBoneQuaternion);
                const parentRotation = bone.parent?.getWorldQuaternion(new THREE.Quaternion()) || new THREE.Quaternion();
                bone.quaternion.copy(parentRotation.invert().multiply(worldRotation));
            } else {
                const delta = point.sub(drag.startPoint);
                const movement = drag.planeBasis
                    ? drag.planeBasis[0].clone().multiplyScalar(delta.dot(drag.planeBasis[0])).addScaledVector(drag.planeBasis[1], delta.dot(drag.planeBasis[1]))
                    : drag.axis.clone().multiplyScalar(delta.dot(drag.axis));
                const position = drag.startBonePosition.clone().add(movement);
                bone.position.copy(bone.parent ? bone.parent.worldToLocal(position) : position);
            }
            bone.updateMatrixWorld(true);
            this.updateIKEffectorPositions?.();
            this.updateMarkers();
            this.requestRender();
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (drag.planeName && drag.planeBasis) {
            const worldDelta = point.sub(drag.startPoint);
            const projectedDelta = drag.planeBasis[0].clone().multiplyScalar(worldDelta.dot(drag.planeBasis[0]))
                .addScaledVector(drag.planeBasis[1], worldDelta.dot(drag.planeBasis[1]));
            const localDelta = this.skinnedMesh.parent
                ? projectedDelta.applyQuaternion(drag.parentWorldQuaternion.clone().invert())
                : projectedDelta;
            this.skinnedMesh.position.copy(drag.startMeshPosition).add(localDelta);
            this.skinnedMesh.updateMatrixWorld(true);
            this.activeCharacterAppearance.transform = this._normalizedCharacterTransform({
                ...this.activeCharacterAppearance.transform,
                x: this.skinnedMesh.position.x,
                y: this.skinnedMesh.position.y,
                z: this.skinnedMesh.position.z,
            });
            this.updateIKEffectorPositions?.();
            this.updateMarkers();
            this.requestRender();
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (drag.rotationAxisName) {
            const currentVector = point.sub(drag.origin).normalize();
            if (currentVector.lengthSq() < 1e-8) return;
            const cross = new THREE.Vector3().crossVectors(drag.startPointerVector, currentVector);
            const angle = Math.atan2(cross.dot(drag.axis), drag.startPointerVector.dot(currentVector));
            const rotationDelta = new THREE.Quaternion().setFromAxisAngle(drag.axis, angle);
            this.applyCharacterControlRotation({
                startTransform: drag.startTransform,
                rotationPivot: drag.rotationPivot,
                startObjectPosition: drag.startObjectPosition,
                startObjectQuaternion: drag.startObjectQuaternion,
            }, rotationDelta);
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        const distance = point.sub(drag.startPoint).dot(drag.axis);
        const worldDelta = drag.axis.clone().multiplyScalar(distance);
        const localDelta = this.skinnedMesh.parent
            ? worldDelta.applyQuaternion(drag.parentWorldQuaternion.clone().invert())
            : worldDelta;
        this.skinnedMesh.position.copy(drag.startMeshPosition).add(localDelta);
        this.skinnedMesh.updateMatrixWorld(true);
        this.activeCharacterAppearance.transform = this._normalizedCharacterTransform({
            ...this.activeCharacterAppearance.transform,
            x: this.skinnedMesh.position.x,
            y: this.skinnedMesh.position.y,
            z: this.skinnedMesh.position.z,
        });
        this.updateIKEffectorPositions?.();
        this.updateMarkers();
        this.requestRender();
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    _finishCharacterAxisDrag(event) {
        if (!this._characterAxisDrag || event.pointerId !== this._characterAxisDrag.pointerId) return;
        const drag = this._characterAxisDrag;
        this._characterAxisDrag = null;
        this._characterAxisHovered = null;
        if (drag.targetBone) {
            this.dispatchPoseChange();
            this.options.onCharacterPoseChange?.();
        } else if (drag.rotationAxisName) {
            if (this.activeCharacterAppearance?.transform) {
                this.options.onCharacterTransformChange?.({ ...this.activeCharacterAppearance.transform });
            }
            this.options.onCharacterPoseChange?.();
        } else if (this.activeCharacterAppearance?.transform) {
            this.options.onCharacterTransformChange?.({ ...this.activeCharacterAppearance.transform });
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        this._updateCharacterRotationGuide();
    }

    _refreshCharacterRotationGuideStyle() {
        if (this._rotationGuideCircle) {
            this._rotationGuideCircle.setAttribute("stroke", this._rotationGuideActive ? "#ffd43b" : "#ff343d");
        }
        if (this._rotationGuideSvg) {
            this._rotationGuideSvg.style.filter = this._rotationGuideActive && this._rotationGuideHovered
                ? "drop-shadow(0 0 5px rgba(255, 212, 59, .9)) drop-shadow(0 0 12px rgba(255, 190, 35, .62))"
                : "none";
        }
    }

    _updateCharacterRotationGuide() {
        if (!this._rotationGuideSvg || !this._rotationGuideCircle || !this.camera) return;
        const rect = this.canvas?.getBoundingClientRect?.();
        if (!rect?.width || !rect?.height) {
            this._rotationGuideSvg.style.display = "none";
            return;
        }
        const characterSelected = this._mannequinVisible !== false && this.skinnedMesh
            && !this._noCharacterSelection && !this._multiCharacterSelection;
        if (characterSelected) {
            this.skinnedMesh.updateMatrixWorld(true);
            if (this.skeleton) this.skeleton.update();
        }
        this.camera.updateMatrixWorld(true);
        const project = (point) => point.project(this.camera);
        this._rotationGuideSvg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
        if (!characterSelected) {
            this._characterAxisHovered = null;
            this._rotationGuideFrame = null;
            this._rotationGuideCircle.style.display = "none";
            // Keep the averaged cast pivot for orbit controls, but don't show
            // a world-axis marker when there is no selected character.
            this._characterAxisGizmo?.replaceChildren();
            if (this._characterAxisGizmo) this._characterAxisGizmo.style.display = "none";
            this._rotationGuideSvg.style.display = "none";
            return;
        }

        const hipBone = this.bones?.[this._centerHipBoneName]
            || this.boneList?.find((bone) => bone.name === this._centerHipBoneName);
        if (!hipBone) return;
        const controlBone = this.selectedBone || hipBone;
        const hipWorld = controlBone.getWorldPosition(new this.THREE.Vector3());
        const hipNdc = project(hipWorld.clone());
        const centerX = (hipNdc.x + 1) * rect.width * 0.5;
        const centerY = (1 - hipNdc.y) * rect.height * 0.5;
        this._characterAxisGizmo && (this._characterAxisGizmo.style.display = "");
        this._drawCharacterAxisGizmo(hipWorld, rect, centerX, centerY, {
            orientation: this._temporaryAxisOrientation || controlBone.getWorldQuaternion(new this.THREE.Quaternion()),
        });
        if (this._lockedBoneName === controlBone.name && this._characterAxisGizmo) {
            const lock = document.createElementNS("http://www.w3.org/2000/svg", "path");
            lock.setAttribute("d", "M 4 8 V 5 A 4 4 0 0 1 12 5 V 8 M 2 8 H 14 V 18 H 2 Z M 8 12 V 15");
            lock.setAttribute("transform", `translate(${centerX + 13} ${centerY - 23})`);
            lock.setAttribute("fill", "none");
            lock.setAttribute("stroke", "#ff4040");
            lock.setAttribute("stroke-width", "2");
            lock.setAttribute("stroke-linecap", "round");
            lock.setAttribute("stroke-linejoin", "round");
            lock.style.pointerEvents = "none";
            this._characterAxisGizmo.appendChild(lock);
        }
        let radius = 0;
        for (const bone of this.boneList || []) {
            if (!bone || bone === hipBone || this._isFingerHandBoneName(bone.name)) continue;
            const point = project(bone.getWorldPosition(new this.THREE.Vector3()));
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
            const x = (point.x + 1) * rect.width * 0.5;
            const y = (1 - point.y) * rect.height * 0.5;
            radius = Math.max(radius, Math.hypot(x - centerX, y - centerY));
        }
        if (!Number.isFinite(radius) || radius < 10 || hipNdc.z < -1 || hipNdc.z > 1) {
            this._rotationGuideSvg.style.display = hipNdc.z >= -1 && hipNdc.z <= 1 ? "block" : "none";
            this._rotationGuideCircle.style.display = "none";
            this._rotationGuideFrame = null;
            return;
        }
        radius = Math.min(radius * 0.72, Math.min(rect.width, rect.height) * 0.36);
        this._rotationGuideFrame = { x: centerX, y: centerY, radius };
        this._rotationGuideSvg.style.display = "block";
        this._rotationGuideCircle.style.display = "block";
        this._rotationGuideCircle.setAttribute("cx", String(centerX));
        this._rotationGuideCircle.setAttribute("cy", String(centerY));
        this._rotationGuideCircle.setAttribute("r", String(radius));
        this._rotationGuideCircle.style.display = "none";
        this._refreshCharacterRotationGuideStyle();
    }

    _isInsideCharacterRotationGuide(clientX, clientY) {
        const frame = this._rotationGuideFrame;
        const rect = this.canvas?.getBoundingClientRect?.();
        if (!frame || !rect) return false;
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        return Math.hypot(x - frame.x, y - frame.y) <= frame.radius;
    }

    _isOnCharacterRotationGuide(clientX, clientY) {
        const frame = this._rotationGuideFrame;
        const rect = this.canvas?.getBoundingClientRect?.();
        if (!frame || !rect) return false;
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const distance = Math.hypot(x - frame.x, y - frame.y);
        return Math.abs(distance - frame.radius) <= 24;
    }

    pickCharacterAtPointer(event) {
        if (!this.initialized || !this.camera || !this.scene) return null;
        const rect = this.canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const pointer = new this.THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
        const characters = [
            { id: null, active: true, mesh: this.skinnedMesh },
            ...[...(this.passiveCharacters?.entries() || [])].map(([id, entry]) => ({ id, active: false, mesh: entry.mesh })),
        ].filter(character => character.mesh?.visible);
        this.scene.updateMatrixWorld(true);
        this.camera.updateMatrixWorld(true);
        // SkinnedMesh caches bounds independently of its geometry. A library
        // pose can move vertices outside the bounds computed for the last pose.
        for (const character of characters) {
            character.mesh.traverse(object => {
                if (!object.isSkinnedMesh) return;
                object.skeleton?.update();
                object.boundingSphere = null;
                object.boundingBox = null;
            });
        }
        this._raycaster.setFromCamera(pointer, this.camera);
        const hit = this._raycaster.intersectObjects(characters.map(character => character.mesh), true)[0];
        if (!hit) return null;
        let object = hit.object;
        while (object) {
            const character = characters.find(character => character.mesh === object);
            if (character) return character;
            object = object.parent;
        }
        return null;
    }

    createCharacterControlGroup() {
        const selected = this.options.getCharacterSelection?.() || [];
        if (selected.length < 2) return null;
        const THREE = this.THREE;
        const items = selected.map(character => {
            const mesh = character.active ? this.skinnedMesh : this.passiveCharacters?.get(String(character.id))?.mesh;
            if (!mesh?.visible) return null;
            mesh.updateMatrixWorld(true);
            return { id: character.id, active: character.active, mesh, zoom: character.transform.zoom,
                transform: { ...character.transform }, position: mesh.position.clone(),
                quaternion: mesh.quaternion.clone(), scale: mesh.scale.clone() };
        }).filter(Boolean);
        if (items.length < 2) return null;
        const pivot = new THREE.Vector3();
        for (const item of items) {
            const bones = item.active ? this.boneList : this.passiveCharacters.get(String(item.id))?.boneList;
            const hip = bones?.find(bone => bone.name === this._centerHipBoneName);
            pivot.add(hip ? hip.getWorldPosition(new THREE.Vector3()) : item.mesh.getWorldPosition(new THREE.Vector3()));
        }
        return { items, pivot: pivot.divideScalar(items.length) };
    }

    applyCharacterControlGroup(group, { translation, rotation, scale = 1, commit = false } = {}) {
        const THREE = this.THREE;
        const states = group.items.map(item => {
            const position = item.position.clone().sub(group.pivot).multiplyScalar(scale);
            if (rotation) position.applyQuaternion(rotation);
            position.add(group.pivot);
            if (translation) position.add(translation);
            item.mesh.position.copy(position);
            item.mesh.quaternion.copy(item.quaternion);
            if (rotation) item.mesh.quaternion.premultiply(rotation);
            item.mesh.scale.copy(item.scale).multiplyScalar(scale);
            item.mesh.updateMatrixWorld(true);
            const transform = { ...item.transform, x: position.x, y: position.y, z: position.z, zoom: item.zoom * scale };
            if (item.active) {
                this.activeCharacterAppearance.transform = transform;
                this.modelRotation = { x: THREE.MathUtils.radToDeg(item.mesh.rotation.x), y: THREE.MathUtils.radToDeg(item.mesh.rotation.y), z: THREE.MathUtils.radToDeg(item.mesh.rotation.z) };
            }
            return { id: item.id, transform, modelRotation: [item.mesh.rotation.x, item.mesh.rotation.y, item.mesh.rotation.z].map(THREE.MathUtils.radToDeg) };
        });
        this.skeleton?.update();
        this.updateIKEffectorPositions?.();
        this.updateMarkers?.();
        this.options.onCharacterGroupChange?.(states, commit);
        this.requestRender();
    }

    beginCharacterControlDrag(event) {
        if (this._noCharacterSelection) return;
        if (!this.initialized || !this.skinnedMesh) return;
        if (this._mannequinVisible === false) return;
        if (!event.ctrlKey) return;
        if (event.button === 0 && this._getJointMarkerAtPointer?.(event)) return;
        const mode = event.button === 0 ? "move" : event.button === 2 ? "rotate-xy-free" : null;
        if (!mode) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const transform = this._normalizedCharacterTransform(this.activeCharacterAppearance?.transform);
        const group = this.createCharacterControlGroup?.();
        const worldPosition = this.skinnedMesh.getWorldPosition(new this.THREE.Vector3());
        const distance = this.camera.position.distanceTo(worldPosition);
        const rect = this.canvas.getBoundingClientRect();
        const unitsPerPixel = (this.camera.isOrthographicCamera
            ? this.camera.top - this.camera.bottom
            : 2 * distance * Math.tan(this.THREE.MathUtils.degToRad(this.camera.fov / 2)))
            / (Math.max(1, rect.height) * this.camera.zoom);
        const cameraRotation = this.camera.getWorldQuaternion(new this.THREE.Quaternion());
        const screenRight = new this.THREE.Vector3(1, 0, 0).applyQuaternion(cameraRotation).normalize();
        const screenUp = new this.THREE.Vector3(0, 1, 0).applyQuaternion(cameraRotation).normalize();
        const screenTowardViewer = new this.THREE.Vector3(0, 0, 1).applyQuaternion(cameraRotation).normalize();
        let rotationCenter = null;
        let lastPointerAngle = null;
        let rotationPivot = null;
        let startObjectPosition = null;
        let startObjectQuaternion = null;
        // Initial projected circumference; refreshed while rotating.
        let trackballPixelRadius = null;
        if (mode === "rotate-z" || mode === "rotate-xy-free") {
            this.skinnedMesh.updateMatrixWorld(true);
            const hipBone = this.bones?.[this._centerHipBoneName]
                || this.boneList?.find((bone) => bone.name === this._centerHipBoneName);
            rotationPivot = hipBone
                ? hipBone.getWorldPosition(new this.THREE.Vector3())
                : this.skinnedMesh.getWorldPosition(new this.THREE.Vector3());
            if (group) rotationPivot.copy(group.pivot);
            const center = rotationPivot.clone().project(this.camera);
            const screenCenterX = rect.left + (center.x + 1) * rect.width * 0.5;
            const screenCenterY = rect.top + (1 - center.y) * rect.height * 0.5;
            rotationCenter = { x: screenCenterX, y: screenCenterY };
            if (mode === "rotate-xy-free") {
                trackballPixelRadius = this._characterTrackballPixelRadius(rotationCenter);
            }
            if (mode === "rotate-z" && Math.hypot(event.clientX - screenCenterX, event.clientY - screenCenterY) >= 8) {
                lastPointerAngle = Math.atan2(event.clientY - screenCenterY, event.clientX - screenCenterX);
            }
            startObjectPosition = this.skinnedMesh.getWorldPosition(new this.THREE.Vector3());
            startObjectQuaternion = this.skinnedMesh.getWorldQuaternion(new this.THREE.Quaternion());
        }
        this._characterControlDrag = {
            group,
            pointerId: event.pointerId,
            mode,
            startX: event.clientX,
            startY: event.clientY,
            startTransform: transform,
            startModelRotation: { ...this.modelRotation },
            unitsPerPixel,
            rotationCenter,
            lastPointerAngle,
            accumulatedPointerAngle: 0,
            rotationPivot,
            startObjectPosition,
            startObjectQuaternion,
            rotationAxisLock: null,
            screenRight,
            screenUp,
            screenTowardViewer,
            cameraRotation,
            trackballPixelRadius,
            accumulatedRotation: new this.THREE.Quaternion(),
            right: screenRight,
            up: screenUp,
        };
        if (mode === "rotate-xy-free") {
            const drag = this._characterControlDrag;
            drag.lastX = event.clientX;
            drag.lastY = event.clientY;
        }
        this.recordState();
        this.canvas.setPointerCapture(event.pointerId);
    }

    _characterTrackballPixelRadius(center) {
        // Rotation attenuation is independent of character scale and camera zoom.
        const rect = this.canvas.getBoundingClientRect();
        return Math.max(1, Math.min(rect.width, rect.height) * 0.5);
    }

    _viewTrackballPixelRadius(pivot) {
        const rect = this.canvas.getBoundingClientRect();
        // Same fixed screen-space radius as character rotation, regardless of
        // frame size, camera zoom, or distance to the view pivot.
        return Math.max(1, Math.min(rect.width, rect.height) * 0.5);
    }

    moveCharacterControlDrag(event) {
        const drag = this._characterControlDrag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;
        if (drag.mode === "move") {
            const dx = deltaX * drag.unitsPerPixel;
            const dy = deltaY * drag.unitsPerPixel;
            if (drag.group) {
                this.applyCharacterControlGroup(drag.group, { translation: drag.screenRight.clone().multiplyScalar(dx).addScaledVector(drag.screenUp, -dy) });
                return;
            }
            const start = drag.startTransform;
            this.setActiveCharacterAppearance({
                transform: {
                    ...start,
                    x: start.x + drag.screenRight.x * dx - drag.screenUp.x * dy,
                    y: start.y + drag.screenRight.y * dx - drag.screenUp.y * dy,
                    z: start.z + drag.screenRight.z * dx - drag.screenUp.z * dy,
                },
            });
            return;
        }
        if (drag.mode === "rotate-xy-free") {
            const rotation = computeTrackballRotation(
                drag.startX - drag.rotationCenter.x, drag.rotationCenter.y - drag.startY,
                event.clientX - drag.rotationCenter.x, drag.rotationCenter.y - event.clientY,
                drag.trackballPixelRadius,
                2.6,
            );
            const worldRotation = drag.cameraRotation.clone().multiply(rotation)
                .multiply(drag.cameraRotation.clone().invert());
            this.applyCharacterControlRotation(drag, worldRotation);
            return;
        }
        if (drag.mode === "rotate-z") {
            if (drag.rotationCenter && drag.lastPointerAngle !== null) {
                const nextAngle = Math.atan2(
                    event.clientY - drag.rotationCenter.y,
                    event.clientX - drag.rotationCenter.x,
                );
                let deltaAngle = nextAngle - drag.lastPointerAngle;
                while (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2;
                while (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;
                drag.accumulatedPointerAngle += deltaAngle;
                drag.lastPointerAngle = nextAngle;
                const rotateZ = new this.THREE.Quaternion().setFromAxisAngle(
                    drag.screenTowardViewer,
                    -drag.accumulatedPointerAngle,
                );
                this.applyCharacterControlRotation(drag, rotateZ);
                return;
            }
            const rotateZ = new this.THREE.Quaternion().setFromAxisAngle(
                drag.screenTowardViewer,
                this.THREE.MathUtils.degToRad(deltaX * 0.5),
            );
            this.applyCharacterControlRotation(drag, rotateZ);
            return;
        }
    }

    applyCharacterControlRotation(drag, rotationDelta) {
        if (drag.group) {
            this.applyCharacterControlGroup(drag.group, { rotation: rotationDelta });
            return;
        }
        if (!this.skinnedMesh || !drag?.rotationPivot || !drag.startObjectQuaternion || !drag.startObjectPosition) return;
        const THREE = this.THREE;
        const position = drag.startObjectPosition.clone()
            .sub(drag.rotationPivot)
            .applyQuaternion(rotationDelta)
            .add(drag.rotationPivot);
        const quaternion = rotationDelta.clone().multiply(drag.startObjectQuaternion);
        const transform = {
            ...drag.startTransform,
            x: position.x,
            y: position.y,
            z: position.z,
        };
        this.setActiveCharacterAppearance({ transform });
        this.skinnedMesh.quaternion.copy(quaternion);
        this.skinnedMesh.rotation.setFromQuaternion(quaternion, "XYZ");
        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();
        this.modelRotation = {
            x: THREE.MathUtils.radToDeg(this.skinnedMesh.rotation.x),
            y: THREE.MathUtils.radToDeg(this.skinnedMesh.rotation.y),
            z: THREE.MathUtils.radToDeg(this.skinnedMesh.rotation.z),
        };
        this.updateIKEffectorPositions?.();
        this.updateMarkers?.();
        this.requestRender();
    }

    finishCharacterControlDrag(event) {
        const drag = this._characterControlDrag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this._characterControlDrag = null;
        if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
        if (drag.group) {
            this.options.onCharacterGroupChange?.([], true);
            return;
        }
        if (drag.mode === "rotate-xy-free" || drag.mode === "rotate-z") {
            if (this.activeCharacterAppearance?.transform) {
                this.options.onCharacterTransformChange?.({ ...this.activeCharacterAppearance.transform });
            }
            this.options.onCharacterPoseChange?.();
        } else if (drag.mode === "move" && this.activeCharacterAppearance?.transform) {
            this.options.onCharacterTransformChange?.({ ...this.activeCharacterAppearance.transform });
        }
    }

    handlePointerDown(e) {
        if (this._lockedBoneName && e.button === 0 && !e.ctrlKey) {
            const hit = this._getJointMarkerAtPointer(e);
            const bone = hit && this.boneList?.[hit.object.userData?.boneIndex];
            if (bone?.name !== this._lockedBoneName) return;
        }
        if (this._multiCharacterSelection || this._noCharacterSelection) return;
        const characterHit = this.pickCharacterAtPointer(e);
        if (characterHit && !characterHit.active) return;
        if (!this.initialized || !this.skinnedMesh) return;
        if (this._mannequinVisible === false) return;
        if (e.button !== 0) return;
        if (this._hoverPointerFrame) {
            cancelAnimationFrame(this._hoverPointerFrame);
            this._hoverPointerFrame = null;
        }
        this._pendingHoverPointer = null;

        // CRITICAL: Force world matrices to update before capturing positions for IK
        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();
        if (this.ikController) this.updateIKEffectorPositions();

        if (this.transform.dragging) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        const raycaster = this._raycaster || new this.THREE.Raycaster();
        const pointer = this._pointerNdc || new this.THREE.Vector2();
        pointer.set(x, y);
        raycaster.setFromCamera(pointer, this.camera);

        // --- IK MODE: Check for pole target hit ---
        if (this.ikMode && this.ikController) {
            const poleMeshes = Object.values(this.ikController.poleTargets).filter(p => p.visible);
            if (poleMeshes.length > 0) {
                const poleIntersects = raycaster.intersectObjects(poleMeshes, false);
                if (poleIntersects.length > 0) {
                    const hitPole = poleIntersects[0].object;
                    this.selectPoleTarget(hitPole);
                    return;
                }
            }
        }

        // --- PASS 1: Test a small screen-space region around each joint center ---
        const markerIntersection = this._getJointMarkerAtPointer(e);

        if (markerIntersection) {
            const hitMarker = markerIntersection.object;
            const boneIdx = hitMarker.userData?.boneIndex;
            if (boneIdx !== -1 && this.boneList[boneIdx]) {
                const bone = this.boneList[boneIdx];

                // Check if this bone is part of an active IK chain
                if (this.ikMode && this.ikController) {
                    const chainKey = this.ikController.getChainForBone(bone.name);
                    if (chainKey && this.ikController.getMode(chainKey) === 'ik') {
                        const chainDef = IK_CHAINS[chainKey];
                        const effectorObj = this.ikController.effectors[chainDef.effector];
                        if (effectorObj) {
                            // Record state for undo before starting the drag
                            this.recordState();

                            // Setup screen-space direct dragging for IK
                            this.directDrag.active = true;
                            this.directDrag.chainKey = chainKey;
                            this.directDrag.effector = effectorObj;
                            this.directDrag.effectorBone = this.bones?.[chainDef.effector] || null;
                            this.directDrag.plane = new this.THREE.Plane();
                            this.directDrag.offset = new this.THREE.Vector3();
                            this.directDrag.hasDragged = false;
                            this.directDrag.clickedBone = bone;
                            this.selectBone(bone);
                            this.directDrag.preserveSelectedBone = true;
                            this.directDrag.startClientX = e.clientX;
                            this.directDrag.startClientY = e.clientY;

                            const isMidJoint = (bone.name === chainDef.poleBone);
                            this.directDrag.targetType = isMidJoint ? 'midJoint' : 'effector';

                            if (isMidJoint) {
                                this.directDrag.midBone = bone;
                                this.directDrag.rootBone = this.boneList.find(b => b.name === chainDef.bones[chainDef.bones.indexOf(bone.name) - 1]);
                            }

                            // Create interaction plane facing camera
                            const cameraDir = new this.THREE.Vector3();
                            this.camera.getWorldDirection(cameraDir);
                            // Base the plane on the clicked bone depth (e.g. knee) to prevent wild parallax errors
                            const clickedBoneWorld = new this.THREE.Vector3();
                            bone.getWorldPosition(clickedBoneWorld);
                            this.directDrag.plane.setFromNormalAndCoplanarPoint(cameraDir, clickedBoneWorld);

                            const intersectPoint = new this.THREE.Vector3();
                            raycaster.ray.intersectPlane(this.directDrag.plane, intersectPoint);
                            if (intersectPoint) {
                                if (isMidJoint) {
                                    this.directDrag.offset.copy(clickedBoneWorld).sub(intersectPoint);
                                } else {
                                    this.directDrag.offset.copy(effectorObj.position).sub(intersectPoint);
                                }
                            }

                            this.orbit.enabled = false; // Disable orbit while direct dragging
                            this.hoveredBoneName = bone.name;
                            this.updateMarkers();

                            // Detach transform immediately so the gizmo doesn't glitch during IK solve
                            this.transform.detach();

                            this.canvas.setPointerCapture(e.pointerId);

                            // Important: don't attach TransformControls here, we handle movement in pointermove
                            if (this.selectedIKEffector) this.deselectIKEffector();
                            if (this.selectedPoleTarget) this.deselectPoleTarget();

                            return;
                        }
                    }
                }

                // Default: select bone for normal FK rotation
                this.selectBone(bone);
                return;
            }
        }

        // Joint marker hits take priority so another joint remains selectable
        // even when the selected joint's rotation gizmo overlaps it.
        if (this.transform.axis) return;

        // --- PASS 2: Fallback to Mesh Intersect ---
        // Useful if user clicks on the body near a joint but misses the sphere.
        const meshIntersects = raycaster.intersectObject(this.skinnedMesh, true);

        if (meshIntersects.length > 0) {
            const point = meshIntersects[0].point;
            let nearest = null;
            let minD = Infinity;

            const wPos = this._pointerWorldPosition || new this.THREE.Vector3();
            for (const b of this.boneList) {
                b.getWorldPosition(wPos);
                const d = point.distanceTo(wPos);
                if (d < minD) { minD = d; nearest = b; }
            }

            // Tighter threshold for mesh-based selection to avoid accidental jumps
            if (nearest && minD < 0.7) {
                nearest = this._resolveHandBone(nearest);
                const handSide = this._getHandSideFromBoneName(nearest?.name);
                if (handSide) {
                    if (this._isHandSurfaceActivation(handSide, point) && this.options.onHandActivate) {
                        this.options.onHandActivate({ side: handSide, boneName: nearest.name, clientX: e.clientX, clientY: e.clientY });
                    } else {
                        this.selectBone(nearest);
                    }
                    return;
                }

                if (this.ikMode && this.ikController) {
                    const chainKey = this.ikController.getChainForBone(nearest.name);
                    if (chainKey && this.ikController.getMode(chainKey) === 'ik') {
                        const chainDef = IK_CHAINS[chainKey];
                        const effectorObj = this.ikController.effectors[chainDef.effector];
                        if (effectorObj) {
                            // Record state for undo before starting the drag
                            this.recordState();

                            // Setup screen-space direct dragging for IK
                            this.directDrag.active = true;
                            this.directDrag.chainKey = chainKey;
                            this.directDrag.effector = effectorObj;
                            this.directDrag.effectorBone = this.bones?.[chainDef.effector] || null;
                            this.directDrag.plane = new this.THREE.Plane();
                            this.directDrag.offset = new this.THREE.Vector3();
                            this.directDrag.hasDragged = false;
                            this.directDrag.clickedBone = nearest;
                            this.selectBone(nearest);
                            this.directDrag.preserveSelectedBone = true;
                            this.directDrag.startClientX = e.clientX;
                            this.directDrag.startClientY = e.clientY;

                            const isMidJoint = (nearest.name === chainDef.poleBone);
                            this.directDrag.targetType = isMidJoint ? 'midJoint' : 'effector';

                            if (isMidJoint) {
                                this.directDrag.midBone = nearest;
                                this.directDrag.rootBone = this.boneList.find(b => b.name === chainDef.bones[chainDef.bones.indexOf(nearest.name) - 1]);
                            }

                            const cameraDir = new this.THREE.Vector3();
                            this.camera.getWorldDirection(cameraDir);

                            // Base the plane on the clicked bone depth (e.g. knee) to prevent wild parallax errors
                            const clickedBoneWorld = new this.THREE.Vector3();
                            nearest.getWorldPosition(clickedBoneWorld);
                            this.directDrag.plane.setFromNormalAndCoplanarPoint(cameraDir, clickedBoneWorld);

                            const intersectPoint = new this.THREE.Vector3();
                            raycaster.ray.intersectPlane(this.directDrag.plane, intersectPoint);
                            if (intersectPoint) {
                                if (isMidJoint) {
                                    this.directDrag.offset.copy(clickedBoneWorld).sub(intersectPoint);
                                } else {
                                    this.directDrag.offset.copy(effectorObj.position).sub(intersectPoint);
                                }
                            }

                            this.orbit.enabled = false;
                            this.hoveredBoneName = nearest.name;
                            this.updateMarkers();

                            // Detach transform immediately so the gizmo doesn't glitch during IK solve
                            this.transform.detach();

                            this.canvas.setPointerCapture(e.pointerId);

                            if (this.selectedIKEffector) this.deselectIKEffector();
                            if (this.selectedPoleTarget) this.deselectPoleTarget();
                            return;
                        }
                    }
                }

                // Default: select bone for normal FK rotation
                this.selectBone(nearest);
                return;
            }

            // A click on the model surface is not an empty-canvas click, even
            // when it is too far from a joint to select one.
        }

        this.deselectBone();
        if (this.selectedIKEffector) {
            this.deselectIKEffector();
        }
    }

    _getJointMarkerAtPointer(event) {
        if (!this.initialized || !this.skinnedMesh || !event || !this.camera) return null;
        const rect = this.canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        this.skinnedMesh.updateMatrixWorld(true);
        this.camera.updateMatrixWorld(true);
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        const projected = new this.THREE.Vector3();
        let bestHit = null;
        let bestScreenDistance = Infinity;
        let bestDepth = Infinity;
        for (const marker of this._getRaycastableJointMarkers()) {
            marker.getWorldPosition(projected);
            projected.project(this.camera);
            if (projected.z < -1 || projected.z > 1 || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue;
            const screenX = (projected.x + 1) * rect.width * 0.5;
            const screenY = (1 - projected.y) * rect.height * 0.5;
            const screenDistance = Math.hypot(screenX - pointerX, screenY - pointerY);
            const bone = this.boneList?.[marker.userData?.boneIndex];
            const isSelected = bone?.name === this.selectedBone?.name;
            const threshold = isSelected ? 12 : (this._isFingerHandBoneName(bone?.name) ? 4 : 5);
            if (screenDistance > threshold) continue;
            const depth = projected.z;
            if (screenDistance < bestScreenDistance || (screenDistance === bestScreenDistance && depth < bestDepth)) {
                bestHit = { object: marker, distance: depth };
                bestScreenDistance = screenDistance;
                bestDepth = depth;
            }
        }
        return bestHit;
    }

    schedulePointerMove(e) {
        // Direct manipulation needs every event for input fidelity. Passive hover
        // raycasts cannot produce more visible updates than the display refresh
        // rate, so only process the latest hover event in each frame.
        if (this.directDrag?.active || e.buttons !== 0 || this.transform?.dragging) {
            this.handlePointerMove(e);
            return;
        }
        this._pendingHoverPointer = {
            clientX: e.clientX,
            clientY: e.clientY,
            buttons: e.buttons,
        };
        if (this._hoverPointerFrame) return;
        this._hoverPointerFrame = requestAnimationFrame(() => {
            this._hoverPointerFrame = null;
            const pending = this._pendingHoverPointer;
            this._pendingHoverPointer = null;
            if (pending) this.handlePointerMove(pending);
        });
    }

    handlePointerMove(e) {
        if (!this.initialized || !this.skinnedMesh) return;

        if (this.directDrag?.active && !this.directDrag.hasDragged) {
            const movedX = e.clientX - this.directDrag.startClientX;
            const movedY = e.clientY - this.directDrag.startClientY;
            if ((movedX * movedX + movedY * movedY) > 9) {
                this.directDrag.hasDragged = true;
            }
        }

        if (!this.directDrag?.active && e.buttons !== 0) return;
        if (!this.directDrag?.active && this.transform.dragging) {
            if (this.hoveredBoneName || this._hoveredHandSide) {
                this.hoveredBoneName = null;
                this._updateHoveredHand(null);
                this.updateMarkers();
                this.requestRender();
            }
            return;
        }

        const rect = this.canvas.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        const raycaster = this._raycaster || new this.THREE.Raycaster();
        const pointer = this._pointerNdc || new this.THREE.Vector2();
        pointer.set(x, y);
        raycaster.setFromCamera(pointer, this.camera);

        // Process Direct Limb Dragging updates IK effector seamlessly in screen space
        if (this.directDrag && this.directDrag.active) {
            const intersectPoint = this._dragIntersectPoint || new this.THREE.Vector3();
            raycaster.ray.intersectPlane(this.directDrag.plane, intersectPoint);

            if (intersectPoint) {
                if (this.directDrag.targetType === 'midJoint') {
                    // Dragging knee/elbow swivels the parent hip/shoulder directly
                    const targetPos = intersectPoint.add(this.directDrag.offset);
                    const rootBone = this.directDrag.rootBone;
                    const midBone = this.directDrag.midBone;

                    if (rootBone && midBone) {


                        const midWorld = new this.THREE.Vector3();
                        midBone.getWorldPosition(midWorld);



                        // Pivot parent to place midBone perfectly on mouse cursor
                        const analytic = this.ikController.ccdSolver.analyticSolver;
                        analytic.rotateBoneToPoint(rootBone, midWorld, targetPos, this.THREE);
                        rootBone.updateMatrixWorld(true);
                        if (this.skeleton) this.skeleton.update();

                        // Snap true IK foot/hand effector target to its new dragged-along position
                        const chainDef = IK_CHAINS[this.directDrag.chainKey];
                        const trueEffectorBone = this.directDrag.effectorBone || this.bones?.[chainDef.effector];
                        if (trueEffectorBone && this.directDrag.effector) {
                            trueEffectorBone.getWorldPosition(this.directDrag.effector.position);
                        }

                        // Vital to manually request redraw in ThreeJS when modifying transform directly outside solver
                        this.updateMarkers();
                        this.requestRender();
                    }
                } else {
                    // Standard Hand/Foot Effector Drag
                    const effectorTargetPos = intersectPoint.add(this.directDrag.offset);
                    this.directDrag.effector.position.copy(effectorTargetPos);

                    this.selectedIKEffector = this.directDrag.effector;
                    this.solveIKForEffector();
                }
            }
            return;
        }

        // --- HOVER LOGIC ---
        let hitBone = null;
        let hoveredHandSide = null;

        const markerIntersection = this._getJointMarkerAtPointer(e);
        if (markerIntersection) {
            const hitMarker = markerIntersection.object;
            const boneIdx = hitMarker.userData?.boneIndex;
            if (boneIdx !== -1 && this.boneList[boneIdx]) {
                hitBone = this.boneList[boneIdx];
            }
        } else {
            const meshIntersects = raycaster.intersectObject(this.skinnedMesh, true);
            if (meshIntersects.length > 0) {
                const point = meshIntersects[0].point;
                let nearest = null;
                let minD = Infinity;

                const wPos = this._pointerWorldPosition || new this.THREE.Vector3();
                for (const b of this.boneList) {
                    b.getWorldPosition(wPos);
                    const d = point.distanceTo(wPos);
                    if (d < minD) { minD = d; nearest = b; }
                }

                if (nearest && minD < 0.7) {
                    const resolvedBone = this._resolveHandBone(nearest);
                    const handSide = this._getHandSideFromBoneName(resolvedBone?.name);
                    if (handSide && this._isHandSurfaceActivation(handSide, point)) {
                        hoveredHandSide = handSide;
                    } else {
                        hitBone = nearest;
                    }
                }
            }
        }

        const newHoveredName = hitBone ? hitBone.name : null;
        if (this.hoveredBoneName !== newHoveredName || this._hoveredHandSide !== hoveredHandSide) {
            this.hoveredBoneName = newHoveredName;
            this._updateHoveredHand(hoveredHandSide);
            this.updateMarkers();
            this.requestRender();
        }
    }

    handlePointerUp(e, { cancelled = false } = {}) {
        if (!this.initialized || !this.skinnedMesh) return;
        if (this._hoverPointerFrame) {
            cancelAnimationFrame(this._hoverPointerFrame);
            this._hoverPointerFrame = null;
        }
        this._pendingHoverPointer = null;

        if (this.directDrag && this.directDrag.active) {
            const dragged = cancelled || !!this.directDrag.hasDragged;
            const clickedBone = this.directDrag.clickedBone || null;
            const preserveSelectedBone = this.directDrag.preserveSelectedBone === true;
            this.directDrag.active = false;
            this.directDrag.effector = null;
            this.directDrag.effectorBone = null;
            this.directDrag.chainKey = null;
            this.directDrag.clickedBone = null;
            this.directDrag.preserveSelectedBone = false;
            this.directDrag.hasDragged = false;
            this.directDrag.startClientX = 0;
            this.directDrag.startClientY = 0;
            this.orbit.enabled = true; // Restore orbit

            if (this.canvas.hasPointerCapture(e.pointerId)) {
                this.canvas.releasePointerCapture(e.pointerId);
            }

            // The solver temporarily set selectedIKEffector, clear it now that drag is done
            if (this.selectedIKEffector) {
                this.selectedIKEffector = null;
            }

            // Trigger sync to update node output after IK drag
            this.isInteractionActive = false;

            if (this.options.onInteractionEnd) {
                this.options.onInteractionEnd({ type: 'ik' });
            }
            this.dispatchPoseChange();

            this.transform.detach();
            if (preserveSelectedBone && clickedBone) {
                this.selectBone(clickedBone);
                this.updateMarkers();
                this.requestRender();
            } else if (dragged) {
                this.hoveredBoneName = null;
                if (!this.deselectBone({ source: 'viewer' })) {
                    this.updateMarkers();
                    this.requestRender();
                }
            } else if (clickedBone) {
                this.selectBone(clickedBone);
            }

            return;
        }
    }

    _emitBoneSelectionChange(previousBone, source) {
        const callback = this.options?.onBoneSelectionChange;
        if (typeof callback !== 'function' || this._emittingBoneSelectionChange) return;

        this._emittingBoneSelectionChange = true;
        try {
            callback({
                boneName: this.selectedBone?.name || null,
                previousBoneName: previousBone?.name || null,
                source,
            });
        } catch (error) {
            if (typeof this.options?.onError === 'function') this.options.onError(error);
        } finally {
            this._emittingBoneSelectionChange = false;
        }
    }

    _getLockableBoneAtPointer(event) {
        const rect = this.canvas?.getBoundingClientRect?.();
        const selectedBone = this.selectedBone;
        let bone = null;
        if (selectedBone && rect) {
            const point = selectedBone.getWorldPosition(new this.THREE.Vector3()).project(this.camera);
            const x = rect.left + (point.x + 1) * rect.width * 0.5;
            const y = rect.top + (1 - point.y) * rect.height * 0.5;
            if (Math.hypot(event.clientX - x, event.clientY - y) <= 18) bone = selectedBone;
        }
        if (!bone) {
            const hit = this._getJointMarkerAtPointer(event);
            bone = hit && this.boneList?.[hit.object.userData?.boneIndex];
        }
        return bone || null;
    }

    resetJointSelectionLock() {
        this._lockedBoneName = null;
        this._jointLockPress = null;
        this._jointLockClick = null;
        this._selectionClickStart = null;
        this.deselectBone({ source: 'external' });
    }

    selectBone(bone, { source = 'viewer' } = {}) {
        if (this._lockedBoneName && bone?.name !== this._lockedBoneName) return false;
        this._temporaryAxisOrientation = null;
        this.requestRender();
        if (!bone || !this.transform) return false;
        if (this._rotationGuideActive) {
            this._rotationGuideActive = false;
            this._rotationGuideHovered = false;
            this._refreshCharacterRotationGuideStyle();
        }
        if (this.selectedBone === bone) return false;
        const previousBone = this.selectedBone;
        this.selectedBone = bone;

        // Joint editing uses the axis/arc overlay instead of rotation rings.
        this.transform.setMode("rotate");
        this.transform.detach();
        this.updateMarkers();

        // Ensure IK effector is deselected if we just want FK bone rotation
        if (this.selectedIKEffector) {
            this.selectedIKEffector = null;
        }
        this.requestRender();
        this._emitBoneSelectionChange(previousBone, source);
        return true;
    }

    deselectBone({ source = 'viewer' } = {}) {
        if (this._lockedBoneName) return false;
        this._temporaryAxisOrientation = null;
        this.requestRender();
        if (!this.selectedBone) return false;
        const previousBone = this.selectedBone;
        this.selectedBone = null;
        this.transform?.detach();
        this.updateMarkers();
        this.requestRender();
        this._emitBoneSelectionChange(previousBone, source);
        return true;
    }

    /**
     * Select a skeleton bone without needing access to the Three.js Bone object.
     * Passing null (or an empty string) clears the selection. Unknown names are
     * rejected without changing the current selection.
     */
    selectBoneByName(name) {
        if (name === null || name === undefined || name === '') {
            this.deselectBone({ source: 'external' });
            return true;
        }
        if (typeof name !== 'string') return false;
        if (!this.initialized || !this.transform) return false;

        const bone = this.bones?.[name] || this.boneList?.find(item => item?.name === name);
        if (!bone) return false;

        this.selectBone(bone, { source: 'external' });
        return true;
    }
    getBoneTimelineContext(name) {
        if (typeof name !== 'string' || !this.bones?.[name]) return [];
        const result = [];
        const seen = new Set();
        const add = boneName => {
            if (!boneName || seen.has(boneName) || !this.bones?.[boneName]) return;
            seen.add(boneName);
            result.push(boneName);
        };

        add(name);
        const chainKey = this.ikController?.getChainForBone?.(name);
        const chain = chainKey ? IK_CHAINS[chainKey] : null;
        for (const boneName of chain?.bones || []) add(boneName);
        add(chain?.effector);
        add(chain?.poleBone);

        let parentName = this.bones[name]?.userData?.parentName;
        while (parentName && this.bones[parentName]) {
            add(parentName);
            parentName = this.bones[parentName]?.userData?.parentName;
        }
        for (const bone of this.boneList || []) {
            if (bone?.userData?.parentName === name) add(bone.name);
        }
        return result;
    }
    setExternalHoveredBone(name) {
        if (name !== null && name !== undefined && name !== '') {
            if (typeof name !== 'string') return false;
            const bone = this.bones?.[name] || this.boneList?.find(item => item?.name === name);
            if (!bone) return false;
            name = bone.name;
        } else {
            name = null;
        }

        if (this.externalHoveredBoneName === name) return true;
        this.externalHoveredBoneName = name;
        this.updateMarkers();
        this.requestRender();
        return true;
    }

    // === IK Methods ===
    initIK() {
        if (!this.THREE) return;
        this.ikController = new IKController(this.THREE);

    }

    selectIKEffector(effectorMesh) {
        // Select the object and attach translation gizmo (IK)
        this.selectedIKEffector = effectorMesh;

        this.selectedPoleTarget = null;

        // Attach transform to the effector mesh (translate mode)
        this.transform.setMode("translate");
        this.transform.attach(effectorMesh);

        // Update markers to show chain selection
        this.updateMarkers();


    }

    deselectIKEffector() {
        if (this.selectedIKEffector) {
            this.selectedIKEffector = null;
        }
        this.transform.detach();
        this.transform.setMode("rotate");
        this.updateMarkers();
    }

    selectPoleTarget(poleMesh) {
        this.selectedPoleTarget = poleMesh;

        // Deselect effector if selected
        if (this.selectedIKEffector) {
            this.selectedIKEffector = null;
        }

        this.selectedPoleTarget = poleMesh;
        poleMesh.material.color.setHex(0xffff00); // Yellow when selected

        // Attach transform to the pole mesh (translate mode)
        this.transform.setMode("translate");
        this.transform.attach(poleMesh);
        const chainKey = poleMesh.userData.chainKey;
        if (chainKey) {
            const chainDef = IK_CHAINS[chainKey];
            if (chainDef && chainDef.effector) {
                const effectorBone = this.bones[chainDef.effector];
                const effector = this.ikController.effectors[chainDef.effector];
                if (effectorBone && effector) {
                    const bonePos = new this.THREE.Vector3();
                    effectorBone.getWorldPosition(bonePos);
                    effector.position.copy(bonePos);
                }
            }
        }

        // Attach transform to the pole target mesh (translate mode)
        this.transform.setMode("translate");
        this.transform.attach(poleMesh);

        // Deselect any bone and update markers
        if (this.selectedBone) {
            const previousBone = this.selectedBone;
            this.selectedBone = null;
            this.updateMarkers();
            this._emitBoneSelectionChange(previousBone, 'ik');
        }


    }

    deselectPoleTarget() {
        if (this.selectedPoleTarget) {
            this.selectedPoleTarget.material.color.setHex(0xff8800);
            this.selectedPoleTarget = null;
        }
        this.transform.detach();
        this.transform.setMode("rotate");
        this.updateMarkers();
    }

    solveIKForEffector() {
        if (!this.ikController || !this.selectedIKEffector || !this.THREE) return;

        const effectorName = this.selectedIKEffector.userData.effectorName;
        const chainKey = this.selectedIKEffector.userData.chainKey;

        if (!effectorName || !chainKey) return;

        // Check if this chain is active for IK
        if (this.ikController.getMode(chainKey) !== 'ik') {

            return;
        }

        // Get target position from effector mesh
        const targetPos = this.selectedIKEffector.position.clone();

        // Solve IK with pole target support
        const chainDef = IK_CHAINS[chainKey];
        if (!chainDef) return;

        // Special handling for root effectors (hips) - translate and solve leg IK
        if (chainDef.isRoot) {
            const effectorBone = this.bones[chainDef.effector];
            if (effectorBone) {
                // Store foot positions BEFORE moving hip (for leg IK solving)
                const footPositions = {};
                if (chainDef.affectedLegs) {
                    for (const legKey of chainDef.affectedLegs) {
                        const legDef = IK_CHAINS[legKey];
                        if (legDef && this.ikController.getMode(legKey) === 'ik') {
                            const footBone = this.bones[legDef.effector];
                            if (footBone) {
                                const footPos = new this.THREE.Vector3();
                                footBone.getWorldPosition(footPos);
                                footPositions[legKey] = footPos;
                            }
                        }
                    }
                }

                // Get the difference
                const bonePos = new this.THREE.Vector3();
                effectorBone.getWorldPosition(bonePos);

                // Apply target world position to bone by converting to parent-local space
                const localTarget = targetPos.clone();
                if (effectorBone.parent) {
                    effectorBone.parent.worldToLocal(localTarget);
                }
                effectorBone.position.copy(localTarget);
                effectorBone.updateMatrixWorld(true);

                // Solve IK for affected legs to keep feet in place
                // Multiple passes for better accuracy
                if (chainDef.affectedLegs && this.ikController.ccdSolver) {
                    const rootBone = this.boneList.find(b => !b.userData.parentName || !this.bones[b.userData.parentName]);
                    const rootY = rootBone ? (() => {
                        const position = new this.THREE.Vector3();
                        rootBone.getWorldPosition(position);
                        return position.y;
                    })() : 0;

                    for (const legKey of chainDef.affectedLegs) {
                        const footTarget = footPositions[legKey];
                        if (footTarget) {
                            footTarget.y = Math.max(rootY, footTarget.y);
                        }
                    }

                    for (let pass = 0; pass < 3; pass++) { // Multiple passes
                        for (const legKey of chainDef.affectedLegs) {
                            const legDef = IK_CHAINS[legKey];
                            const footTarget = footPositions[legKey];

                            if (legDef && footTarget && this.ikController.getMode(legKey) === 'ik') {
                                // Solve leg IK to keep foot at original position
                                this.ikController.solveWithPole(legDef, this.bones, footTarget, legKey);
                            }
                        }
                        // Update matrix world between passes
                        for (const bone of this.boneList) {
                            bone.updateMatrixWorld(true);
                        }
                    }
                }

                // Update skeleton and mesh
                if (this.skeleton) {
                    this.skeleton.update();
                }
                if (this.skinnedMesh) {
                    this.skinnedMesh.updateMatrixWorld(true);
                }

                // Update all other IK effector positions since root moved
                this.updateIKEffectorPositions();

                // Update hip effector position to match new hip position
                const newHipPos = new this.THREE.Vector3();
                effectorBone.getWorldPosition(newHipPos);
                this.selectedIKEffector.position.copy(newHipPos);
            }

            // Don't update pole target positions - they should stay where user placed them
        } else if (this.ikController.ccdSolver) {
            // Standard IK solve for limbs
            this.ikController.solveWithPole(chainDef, this.bones, targetPos, chainKey);

            // Update skeleton after IK solve
            if (this.skeleton) {
                this.skeleton.update();
            }

            // Update skinnedMesh matrix
            if (this.skinnedMesh) {
                this.skinnedMesh.updateMatrixWorld(true);
            }

            // Don't update pole target positions - they should stay where user placed them
        }

        this.requestRender();
    }

    solveIKForPoleTarget() {
        // Called when pole target is moved - re-solve IK for the chain
        if (!this.ikController || !this.selectedPoleTarget || !this.THREE) return;

        const chainKey = this.selectedPoleTarget.userData.chainKey;
        if (!chainKey) return;

        const chainDef = IK_CHAINS[chainKey];
        if (!chainDef) return;

        // Get effector position from the effector mesh
        const effector = this.ikController.effectors[chainDef.effector];
        if (!effector) return;

        const targetPos = effector.position.clone();

        // Solve IK with the moved pole target
        if (this.ikController.ccdSolver) {
            this.ikController.solveWithPole(chainDef, this.bones, targetPos, chainKey);

            // Update skeleton after IK solve
            if (this.skeleton) {
                this.skeleton.update();
            }

            // Update skinnedMesh matrix
            if (this.skinnedMesh) {
                this.skinnedMesh.updateMatrixWorld(true);
            }

            this.requestRender();
        }
    }

    setIKMode(enabled) {
        this.ikMode = enabled;

        // Deselect any IK effector when switching modes
        if (!enabled && this.selectedIKEffector) {
            this.deselectIKEffector();
        }

        // Deselect any pole target when switching modes
        if (!enabled && this.selectedPoleTarget) {
            this.deselectPoleTarget();
        }

        // Ensure transform is in rotate mode for FK
        if (!enabled && this.transform) {
            this.transform.setMode("rotate");
        }

        // Update effector visibility
        this.updateIKEffectorVisibility();
        // Update pole target visibility
        this.updatePoleTargetVisibility();

        // Force immediate render
        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
            this.options.onViewportRender?.();
        }
    }

    setShoulderIKEnabled(enabled) {
        this.shoulderIKEnabled = enabled;
        this.updateIKEffectorVisibility();
        this.requestRender();
    }

    updateIKEffectorVisibility() {
        if (!this.ikController) return;

        for (const [name, effector] of Object.entries(this.ikController.effectors)) {
            // Only show effector if IK mode is on AND the chain is active
            const chainKey = this.ikController.getChainForEffector(name);
            const chainActive = chainKey && this.ikController.getMode(chainKey) === 'ik';
            const shoulderVisible = !chainKey || !IK_CHAINS[chainKey]?.isShoulder || this.shoulderIKEnabled;
            effector.visible = this.ikMode && chainActive && shoulderVisible;
        }
    }

    updatePoleTargetVisibility() {
        if (!this.ikController) return;

        for (const [chainKey, poleTarget] of Object.entries(this.ikController.poleTargets)) {
            // Only show pole target if IK mode is on, chain is active, and pole is enabled
            const chainActive = this.ikController.getMode(chainKey) === 'ik';
            const poleEnabled = this.ikController.getPoleMode(chainKey) === 'on';
            poleTarget.visible = this.ikMode && chainActive && poleEnabled;
        }
    }

    ensurePoleTargetsCreated() {
        if (!this.ikController || !this.THREE || !this.scene || !this.bones) return;

        for (const [chainKey, chainDef] of Object.entries(IK_CHAINS)) {
            if (chainDef.poleBone && !this.ikController.poleTargets[chainKey]) {
                this.createPoleTargetForChain(chainKey, chainDef);
            }
        }
        this.requestRender();
    }

    _calculatePolePosition(chainKey, chainDef) {
        const poleBone = this.bones[chainDef.poleBone];
        if (!poleBone) return null;

        const polePos = new this.THREE.Vector3();
        poleBone.getWorldPosition(polePos);

        const isArm = chainKey.includes('Arm');
        const isLeft = chainKey.includes('left');

        const rootBoneName = chainDef.bones[0];
        const rootBone = this.bones[rootBoneName];

        if (rootBone) {
            const rootPos = new this.THREE.Vector3();
            rootBone.getWorldPosition(rootPos);
            const limbDir = polePos.clone().sub(rootPos).normalize();
            const worldUp = new this.THREE.Vector3(0, 1, 0);

            let outDir = new this.THREE.Vector3().crossVectors(limbDir, worldUp);
            if (outDir.lengthSq() < 0.001) {
                outDir = new this.THREE.Vector3(isLeft ? 1 : -1, 0, 0);
            }
            outDir.normalize();

            const sideOffset = isLeft ? 1 : -1;
            if (isArm) {
                const outwardOffset = outDir.clone().multiplyScalar(sideOffset * 1.0);
                const forwardOffset = new this.THREE.Vector3(0, 0, -0.8);
                polePos.add(outwardOffset).add(forwardOffset);
            } else {
                const outwardOffset = outDir.clone().multiplyScalar(sideOffset * 0.3);
                const forwardOffset = new this.THREE.Vector3(0, 0, 0.5);
                polePos.add(outwardOffset).add(forwardOffset);
            }
        }
        return polePos;
    }

    updatePoleTargetPositions() {
        if (!this.ikController || !this.THREE || !this.bones) return;

        for (const [chainKey, chainDef] of Object.entries(IK_CHAINS)) {
            if (!chainDef.poleBone) continue;
            const poleTarget = this.ikController.poleTargets[chainKey];
            if (!poleTarget || poleTarget === this.selectedPoleTarget) continue;
            if (this.ikController.isPoleTargetEnabled(chainKey)) continue;

            const polePos = this._calculatePolePosition(chainKey, chainDef);
            if (polePos) poleTarget.position.copy(polePos);
        }
    }

    createPoleTargetForChain(chainKey, chainDef) {
        const polePos = this._calculatePolePosition(chainKey, chainDef);
        if (!polePos) return;

        const poleBone = this.bones[chainDef.poleBone];
        const poleHelper = this.ikController.createPoleTargetHelper(chainKey, poleBone, this.THREE);
        poleHelper.position.copy(polePos);

        const chainActive = this.ikController.getMode(chainKey) === 'ik';
        const poleEnabled = this.ikController.getPoleMode(chainKey) === 'on';
        poleHelper.visible = this.ikMode && chainActive && poleEnabled;

        this.scene.add(poleHelper);

    }

    createIKEffectorHelpers() {
        if (!this.ikController || !this.THREE || !this.scene) return;

        // Clean up old effectors
        for (const [name, effector] of Object.entries(this.ikController.effectors)) {
            this.scene.remove(effector);
        }
        this.ikController.effectors = {};

        // Clean up old pole targets
        for (const [key, poleTarget] of Object.entries(this.ikController.poleTargets)) {
            this.scene.remove(poleTarget);
        }
        this.ikController.poleTargets = {};

        // Find the root bone (bone without parent) for hips IK
        // Then use its FIRST CHILD as the hips effector (pelvis/hip bone)
        let rootBoneName = null;
        let rootBone = null;

        // Debug: log all bones and their parents


        // Find the root bone (no parent)
        for (const bone of this.boneList) {
            const pName = bone.userData.parentName;
            if (!pName || !this.bones[pName]) {
                rootBone = bone;
                rootBoneName = bone.name;

                break;
            }
        }

        // Now find the FIRST CHILD of root bone - this is the hips/pelvis
        let hipsBone = null;
        let hipsBoneName = null;

        if (rootBone) {
            for (const bone of this.boneList) {
                if (bone.userData.parentName === rootBoneName) {
                    hipsBone = bone;
                    hipsBoneName = bone.name;

                    break;
                }
            }
        }

        // Fallback to root if no child found
        if (!hipsBone && rootBone) {
            hipsBone = rootBone;
            hipsBoneName = rootBoneName;

        }
        this._centerHipBoneName = hipsBoneName;
        this.jointMarkers.forEach(marker => {
            marker.visible = this._mannequinVisible !== false && this._shouldMarkerBeVisible(marker);
        });

        let createdCount = 0;
        for (const [chainKey, chainDef] of Object.entries(IK_CHAINS)) {
            // Special handling for hips - use dynamically found hips bone (child of root)
            let effectorBone;
            let effectorName;

            if (chainDef.isRootBone) {
                effectorBone = hipsBone;
                effectorName = hipsBoneName;
                // Store the found effector name in chainDef for later use
                chainDef.effector = effectorName;
                chainDef.bones = [effectorName];
            } else {
                effectorName = chainDef.effector;
                effectorBone = this.bones[effectorName];
            }

            if (effectorBone) {
                // Create effector at bone position
                const bonePos = new this.THREE.Vector3();
                effectorBone.getWorldPosition(bonePos);

                const isRoot = chainDef.isRoot || false;
                const helper = this.ikController.createEffectorHelper(effectorName, effectorBone, this.THREE, isRoot);
                helper.userData.effectorName = effectorName;
                helper.userData.chainKey = chainKey;

                // Check if this chain is active for IK
                const chainActive = this.ikController.getMode(chainKey) === 'ik';
                helper.visible = this.ikMode && chainActive;

                // Position in world space (not attached to bone)
                helper.position.copy(bonePos);

                this.scene.add(helper);
                createdCount++;
            }

            // Create pole target for chains that have poleBone defined
            if (chainDef.poleBone && !this.ikController.poleTargets[chainKey]) {
                this.createPoleTargetForChain(chainKey, chainDef);
            }
        }

    }

    updateIKEffectorPositions(mode = 'nonSelected') {
        if (!this.ikController || !this.THREE) return;

        for (const [chainKey, chainDef] of Object.entries(IK_CHAINS)) {
            const effector = this.ikController.effectors[chainDef.effector];
            if (!effector) continue;

            const isSelected = (effector === this.selectedIKEffector);
            if (mode === 'nonSelected' && isSelected) continue;
            if (mode === 'selectedOnly' && !isSelected) continue;

            const effectorBone = this.bones[chainDef.effector];
            if (effectorBone) {
                const bonePos = new this.THREE.Vector3();
                effectorBone.getWorldPosition(bonePos);
                effector.position.copy(bonePos);
            }
        }
    }

    updateMarkers() {
        if (!this.markerMatNormal || !this.markerMatSelected || !this.markerMatHovered || !this.markerMatHandHover) return;

        const selectedBoneName = this.selectedBone?.name || null;

        // Hover highlights only the joint directly under the pointer. Unlike
        // selection, hover must not expand across the bone's IK chain.
        const hoveredBones = new Set([
            this.hoveredBoneName,
            this.externalHoveredBoneName,
        ].filter(Boolean));

        for (let i = 0; i < this.jointMarkers.length; i++) {
            const marker = this.jointMarkers[i];
            const bone = this.boneList[marker.userData?.boneIndex];
            if (!this._shouldMarkerBeVisible(marker)) {
                marker.visible = false;
                continue;
            }
            const isSelected = bone && bone.name === selectedBoneName;
            const isHovered = bone && hoveredBones.has(bone.name);
            const isCenterHip = bone && (bone.name === this._centerHipBoneName || /^(hips?|pelvis)$/i.test(bone.name));
            marker.visible = true;

            const isOriginHovered = isHovered && (isSelected || (!selectedBoneName && isCenterHip));
            marker.material = isOriginHovered
                ? this.markerMatCenterHipHover
                : isSelected
                ? this.markerMatSelected
                : isCenterHip
                ? (isHovered ? this.markerMatCenterHipHover : this.markerMatCenterHip)
                : isHovered
                    ? this.markerMatHovered
                    : this.markerMatNormal;

            if (isCenterHip) {
                marker.scale.setScalar(isSelected || isHovered ? 2.4 : 2.0);
                marker.renderOrder = 999;
            } else if (isSelected) {
                marker.scale.setScalar(1.5);
                marker.renderOrder = 999;
            } else if (isHovered) {
                marker.scale.setScalar(1.25);
                marker.renderOrder = 500;
            } else {
                marker.scale.setScalar(1.0);
                marker.renderOrder = 1;
            }
        }
    }

    resize(w, h) {
        if (!(w > 0 && h > 0)) return;
        const profile = typeof this.options?.profileResizePhase === 'function'
            ? this.options.profileResizePhase
            : (_name, callback) => callback();
        this.width = w;
        this.height = h;
        this._viewportSizeObserved = true;

        // WebGLRenderer.setSize() reallocates the antialiased preserved drawing
        // buffer. Doing that for every node-resize tick is the main difference
        // from the lightweight UniCanvas 2D path. Allocate once at the first real
        // DOM size, then keep the editor buffer stable. CSS still fills the panel;
        // updating camera.aspect below compensates for its current shape, so the
        // mannequin keeps correct proportions without repeated GPU allocations.
        if (this.renderer && !this._viewportBufferLocked) {
            profile("Three WebGL buffer allocation", () => {
                this.renderer.setSize(w, h, false);
            });
            this._viewportBufferLocked = true;
        }
        if (this.camera) {
            profile("Three camera projection", () => {
                this.camera.aspect = w / h;
                if (this.camera.isOrthographicCamera) {
                    this.camera.right = this.camera.top * this.camera.aspect;
                    this.camera.left = -this.camera.right;
                }
                this.camera.updateProjectionMatrix();
            });
        }
        if (this.initialized && this.renderer && this.scene && this.camera) {
            profile("Three renderer.render", () => {
                this.renderer.render(this.scene, this.camera);
            });
            this._updateCharacterRotationGuide();
            this._needsRender = false;
            this.options.onViewportRender?.();
        } else {
            this.requestRender();
        }
    }

    loadData(data, keepCamera = false) {
        if (!this.initialized || !this.THREE || !this.scene) {
            this.pendingData = { data, keepCamera };
            return;
        }
        if (!data || !data.vertices || !data.bones) return;

        // A model refresh replaces every Three.js Bone instance. Preserve the
        // logical selection by name, but detach from the obsolete skeleton
        // before disposing it so TransformControls cannot retain a stale bone.
        const selectedBoneName = this.selectedBone?.name || null;
        this.transform?.detach();
        this.selectedBone = null;
        this.selectedIKEffector = null;
        this.selectedPoleTarget = null;
        this.hoveredBoneName = null;
        // Hand hover helpers capture Bone instances in their render callback,
        // so dispose them before replacing the skeleton.
        this._updateHoveredHand(null);
        this.hideHandHighlightRing();
        this.unhighlightHandMarkers();
        this._cleanupPrevious();

        const { geometry, vertices, indices } = this._initMeshGeometry(data);
        const THREE = this.THREE;

        // Center camera
        geometry.computeBoundingBox();
        const center = geometry.boundingBox.getCenter(new THREE.Vector3());
        this.meshCenter = center.clone();
        if (!this.sceneCameraTarget) this.sceneCameraTarget = center.clone();
        const size = geometry.boundingBox.getSize(new THREE.Vector3());
        if (!keepCamera && size.length() > 0.1 && this.orbit) {
            this.orbit.target.copy(center);
            const dist = size.length() * 1.5;
            const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
            if (dir.lengthSq() < 0.001) dir.set(0, 0, 1);
            this.camera.position.copy(this.orbit.target).add(dir.multiplyScalar(dist));
            this.orbit.update();
        }

        this._initSkeleton(data, geometry, vertices);
        this.modelLandmarks = data.landmarks || {};
        this.modelLandmarkIndices = data.landmark_indices || {};
        this._createJointMarkers();

        // Apply cached bone scales
        if (this.headScale !== 1.0) {
            this.updateHeadScale(this.headScale);
        }
        if (this.armScale !== 1.0) {
            this.updateArmScale(this.armScale);
        }
        if (this.handScale !== 1.0) {
            this.updateHandScale(this.handScale);
        }
        if (this.footScale !== 1.0) {
            this.updateFootScale(this.footScale);
        }
        this.applyBoneLengthScales();
        this._cacheShapedRestBonePositions();

        this._initIKHelpers();
        this._hideRootToHipSkeletonSegment();
        if (selectedBoneName && this.bones?.[selectedBoneName]) {
            this.selectBone(this.bones[selectedBoneName], { source: 'external' });
        }
        if (this.externalHoveredBoneName && !this.bones?.[this.externalHoveredBoneName]) {
            this.externalHoveredBoneName = null;
        }
        this.updateMarkers();
        this.requestRender();
    }

    _cleanupPrevious() {
        this.skeleton?.dispose?.();
        this.skeletonHelper?.geometry?.dispose?.();
        this.skeletonHelper?.material?.dispose?.();
        if (this.skinnedMesh) {
            this.scene.remove(this.skinnedMesh);
            this.skinnedMesh.geometry.dispose();
            this.skinnedMesh.material.dispose();
            if (this.skeletonHelper) this.scene.remove(this.skeletonHelper);
        }
        if (this.jointMarkers) {
            this.jointMarkers.forEach(m => {
                if (m.parent) m.parent.remove(m);
                // Geometries are shared, but material might need disposal if unique
                if (m.material && m.material.dispose && !m.userData.sharedMaterial) m.material.dispose();
            });
        }
        this.jointMarkers = [];
    }

    _initMeshGeometry(data) {
        const vertices = new Float32Array(data.vertices);
        const indices = new Uint32Array(data.indices);
        const geometry = new this.THREE.BufferGeometry();
        geometry.setAttribute('position', new this.THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(new this.THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();
        return { geometry, vertices, indices };
    }

    _markSkinTextureReady() {
        this._skinTextureReady = true;
        this._skinTexturePromise = Promise.resolve(true);
    }

    _loadSkinTexture(skinType, onReady) {
        const token = ++this._skinTextureLoadToken;
        const skinFile = this._skinTextureFilename(skinType);
        this._skinTextureReady = false;

        const promise = new Promise((resolve) => {
            const texLoader = new this.THREE.TextureLoader();
            texLoader.load(
                `${EXTENSION_URL}textures/${skinFile}?v=${Date.now()}`,
                (tex) => {
                    if (token !== this._skinTextureLoadToken || !this.initialized) {
                        tex?.dispose?.();
                        resolve(false);
                        return;
                    }
                    this.cachedSkinTexture = tex;
                    this.cachedSkinType = skinType;
                    this._cachedSkinTextureReady = true;
                    onReady?.(tex);
                    this._skinTextureReady = true;
                    this.requestRender();
                    resolve(true);
                },
                undefined,
                (error) => {
                    if (token === this._skinTextureLoadToken) {
                        // The untextured material has a neutral fallback color,
                        // so capture can continue without producing a silhouette.
                        this._skinTextureReady = true;
                        console.error(`Failed to load skin texture: ${skinFile}`, error);
                    }
                    resolve(false);
                },
            );
        });
        this._skinTexturePromise = promise;
        return promise;
    }

    _skinTextureFilename(skinType) {
        return {
            naked: "skin.png",
            naked_marks: "skin_marks.png",
            dummy_white: "skin_dummy.png",
        }[skinType] || "skin_dummy.png";
    }

    updateBodyVertices(
        vertices,
        bonePositions = null,
        landmarks = null,
        landmarkIndices = null,
        indices = null,
    ) {
        if (!this.initialized || !this.skinnedMesh || !this.skinnedMesh.geometry || !vertices) return false;
        const geometry = this.skinnedMesh.geometry;
        const position = geometry.getAttribute('position');
        if (!position || position.array.length !== vertices.length) return false;

        const savedRotations = new Map();
        let savedMeshRotation = null;
        let savedMeshPosition = null;
        let savedMeshScale = null;
        if (bonePositions && this.boneList?.length && bonePositions.length >= this.boneList.length * 6) {
            for (const bone of this.boneList) {
                savedRotations.set(bone.name, bone.rotation.clone());
                bone.rotation.set(0, 0, 0);
            }
            savedMeshRotation = this.skinnedMesh.rotation.clone();
            savedMeshPosition = this.skinnedMesh.position.clone();
            savedMeshScale = this.skinnedMesh.scale.clone();
            // The original bind pose is created before a character-specific
            // X/Y/Zoom transform is applied. Recalculate inverses in that same
            // neutral mesh space or the skin cancels the character transform
            // while SkeletonHelper continues to follow the transformed bones.
            this.skinnedMesh.rotation.set(0, 0, 0);
            this.skinnedMesh.position.set(0, 0, 0);
            this.skinnedMesh.scale.set(1, 1, 1);
        }

        position.array.set(vertices);
        position.needsUpdate = true;
        if (indices && indices.length) {
            geometry.setIndex(new this.THREE.BufferAttribute(new Uint32Array(indices), 1));
        }
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        if (geometry.boundingBox && this.THREE) {
            if (!this.meshCenter) this.meshCenter = new this.THREE.Vector3();
            geometry.boundingBox.getCenter(this.meshCenter);
        }

        if (bonePositions && this.boneList?.length && bonePositions.length >= this.boneList.length * 6) {
            for (let i = 0; i < this.boneList.length; i++) {
                const bone = this.boneList[i];
                const offset = i * 6;
                const head = [
                    bonePositions[offset],
                    bonePositions[offset + 1],
                    bonePositions[offset + 2],
                ];
                const tail = [
                    bonePositions[offset + 3],
                    bonePositions[offset + 4],
                    bonePositions[offset + 5],
                ];
                bone.userData.headPos = head;
                bone.userData.tailPos = tail;

                const parentName = bone.userData.parentName;
                const parent = parentName ? this.bones?.[parentName] : null;
                if (parent?.userData?.headPos) {
                    const parentHead = parent.userData.headPos;
                    bone.position.set(
                        head[0] - parentHead[0],
                        head[1] - parentHead[1],
                        head[2] - parentHead[2]
                    );
                } else {
                    bone.position.set(head[0], head[1], head[2]);
                }

                if (this.initialBoneStates?.[bone.name]) {
                    this.initialBoneStates[bone.name].position.copy(bone.position);
                }
            }

            this.skinnedMesh.updateMatrixWorld(true);
            for (const bone of this.boneList) bone.updateMatrixWorld(true);
            if (this.skeleton?.calculateInverses) {
                this.skeleton.calculateInverses();
            }

            for (const bone of this.boneList) {
                const rotation = savedRotations.get(bone.name);
                if (rotation) bone.rotation.copy(rotation);
            }
            if (savedMeshRotation) this.skinnedMesh.rotation.copy(savedMeshRotation);
            if (savedMeshPosition) this.skinnedMesh.position.copy(savedMeshPosition);
            if (savedMeshScale) this.skinnedMesh.scale.copy(savedMeshScale);
            this.skinnedMesh.updateMatrixWorld(true);
            if (this.skeleton) this.skeleton.update();
            this.applyBoneLengthScales();
            this._cacheShapedRestBonePositions();
            this.updateIKEffectorPositions?.();
        }

        if (landmarks && typeof landmarks === 'object') {
            this.modelLandmarks = landmarks;
        }
        if (landmarkIndices && typeof landmarkIndices === 'object') {
            this.modelLandmarkIndices = landmarkIndices;
        }

        this.requestRender();
        return true;
    }

    _initSkeleton(data, geometry, vertices) {
        const THREE = this.THREE;
        this.bones = {};
        this.boneList = [];
        const rootBones = [];

        for (const bData of data.bones) {
            const bone = new THREE.Bone();
            bone.name = bData.name;
            bone.userData = {
                headPos: bData.headPos,
                tailPos: bData.tailPos,
                parentName: bData.parent,
            };
            bone.position.set(bData.headPos[0], bData.headPos[1], bData.headPos[2]);
            this.bones[bone.name] = bone;
            this.boneList.push(bone);
        }

        for (const bone of this.boneList) {
            const pName = bone.userData.parentName;
            if (pName && this.bones[pName]) {
                const parent = this.bones[pName];
                parent.add(bone);
                const pHead = parent.userData.headPos;
                const cHead = bone.userData.headPos;
                bone.position.set(cHead[0] - pHead[0], cHead[1] - pHead[1], cHead[2] - pHead[2]);
            } else {
                rootBones.push(bone);
            }
        }

        this.initialBoneStates = {};
        for (const bone of this.boneList) {
            this.initialBoneStates[bone.name] = {
                position: bone.position.clone(),
                rotation: bone.rotation.clone()
            };
        }
        this.shapedBoneRestPositions = Object.fromEntries(
            this.boneList.map(bone => [bone.name, bone.position.clone()]),
        );

        this.skeleton = new THREE.Skeleton(this.boneList);

        const vCount = vertices.length / 3;
        let skinInds = new Uint16Array(vCount * 4);
        let skinWgts = new Float32Array(vCount * 4);
        const boneHeads = this.boneList.map(b => b.userData.headPos);

        if (
            data.skinIndices
            && data.skinWeights
            && data.skinIndices.length === vCount * 4
            && data.skinWeights.length === vCount * 4
        ) {
            skinInds = new Uint16Array(data.skinIndices);
            skinWgts = new Float32Array(data.skinWeights);
        } else if (data.weights) {
            const vWeights = new Array(vCount).fill(null).map(() => []);
            const boneMap = {};
            this.boneList.forEach((b, i) => boneMap[b.name] = i);

            for (const [bName, wData] of Object.entries(data.weights)) {
                if (boneMap[bName] === undefined) continue;
                const bIdx = boneMap[bName];
                const wInds = wData.indices;
                const wVals = wData.weights;
                for (let i = 0; i < wInds.length; i++) {
                    const vi = wInds[i];
                    if (vi < vCount) vWeights[vi].push({ b: bIdx, w: wVals[i] });
                }
            }

            for (let v = 0; v < vCount; v++) {
                const vw = vWeights[v];
                vw.sort((a, b) => b.w - a.w);
                let tot = 0;
                for (let i = 0; i < 4 && i < vw.length; i++) {
                    skinInds[v * 4 + i] = vw[i].b;
                    skinWgts[v * 4 + i] = vw[i].w;
                    tot += vw[i].w;
                }
                if (tot > 0) {
                    for (let i = 0; i < 4; i++) skinWgts[v * 4 + i] /= tot;
                } else {
                    const vx = vertices[v * 3];
                    const vy = vertices[v * 3 + 1];
                    const vz = vertices[v * 3 + 2];
                    let nearestIdx = 0;
                    let minDistSq = Infinity;
                    for (let bi = 0; bi < boneHeads.length; bi++) {
                        const h = boneHeads[bi];
                        const dx = vx - h[0], dy = vy - h[1], dz = vz - h[2];
                        const dSq = dx * dx + dy * dy + dz * dz;
                        if (dSq < minDistSq) { minDistSq = dSq; nearestIdx = bi; }
                    }
                    skinInds[v * 4] = nearestIdx;
                    skinWgts[v * 4] = 1;
                }
            }
        }

        geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinInds, 4));
        geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWgts, 4));

        if (data.uvs && data.uvs.length > 0) {
            geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(data.uvs), 2));
        }

        const skinType = this.currentSkinType || "naked_marks";
        const textureSkinningEnabled = this.options.enableTextureSkinning
            && this.options.skinMode !== 'flat_color';
        const skinTex = textureSkinningEnabled
            && this._cachedSkinTextureReady
            && this.cachedSkinTexture
            && this.cachedSkinType === skinType
            ? this.cachedSkinTexture
            : null;

        const material = new THREE.MeshPhongMaterial({
            map: skinTex,
            // Never bind TextureLoader's not-yet-loaded placeholder: sampling
            // it produces the black Pose Manager silhouettes seen on startup.
            color: skinTex ? 0xffffff : (textureSkinningEnabled ? 0xc8b5aa : 0xaaaaaa),
            specular: 0x24201d,
            shininess: 12,
            side: THREE.DoubleSide
        });

        this._configureHorizonFadeMaterial(material);

        this.skinnedMesh = new THREE.SkinnedMesh(geometry, material);
        rootBones.forEach(b => this.skinnedMesh.add(b));
        this.skinnedMesh["bind"](this.skeleton);
        this.scene.add(this.skinnedMesh);
        this._updateHorizonFadeUniforms();
        this._applyCharacterTransform(this.skinnedMesh, this.activeCharacterAppearance?.transform);
        this._applyActiveCharacterColor();
        this.skeletonHelper = new THREE.SkeletonHelper(this.skinnedMesh);
        const skeletonColors = this.skeletonHelper.geometry.getAttribute("color");
        if (skeletonColors) {
            for (let index = 0; index < skeletonColors.count; index += 1) {
                skeletonColors.setXYZ(index, 0.48, 0.48, 0.48);
            }
            skeletonColors.needsUpdate = true;
        }
        this.skeletonHelper.material.depthTest = false;
        this.skeletonHelper.material.depthWrite = false;
        this.skeletonHelper.renderOrder = 20;
        this.scene.add(this.skeletonHelper);

        if (!textureSkinningEnabled || skinTex) {
            this._skinTextureLoadToken += 1;
            this._markSkinTextureReady();
        } else {
            this._loadSkinTexture(skinType, (tex) => {
                if (this.skinnedMesh?.material !== material) return;
                this._applyTextureToAllCharacters(tex);
            });
        }
    }

    _createJointMarkers() {
        if (!this.boneList) return;
        const THREE = this.THREE;
        if (!this.markerGeoNormal) this.markerGeoNormal = new THREE.SphereGeometry(0.08, 8, 8);
        if (!this.markerGeoFinger) this.markerGeoFinger = new THREE.SphereGeometry(0.04, 6, 6);

        if (!this.markerMatNormal) {
            this.markerMatNormal = new THREE.MeshBasicMaterial({
                color: 0x168bff, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false
            });
        }
        if (!this.markerMatSelected) {
            this.markerMatSelected = new THREE.MeshBasicMaterial({
                color: 0xffff00, transparent: true, opacity: 1, depthTest: false, depthWrite: false
            });
        }
        if (!this.markerMatHovered) {
            this.markerMatHovered = new THREE.MeshBasicMaterial({
                color: 0xffff00, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false
            });
        }
        if (!this.markerMatHandHover) {
            this.markerMatHandHover = new THREE.MeshBasicMaterial({
                color: 0xffd666, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false
            });
        }
        if (!this.markerMatCenterHip) {
            this.markerMatCenterHip = new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false
            });
        }
        if (!this.markerMatCenterHipHover) {
            this.markerMatCenterHipHover = new THREE.MeshBasicMaterial({
                color: 0x00e5ff, transparent: true, opacity: 1, depthTest: false, depthWrite: false
            });
        }

        for (let i = 0; i < this.boneList.length; i++) {
            const bone = this.boneList[i];
            const isFinger = this._isFingerHandBoneName(bone.name);
            const sphere = new THREE.Mesh(isFinger ? this.markerGeoFinger : this.markerGeoNormal, this.markerMatNormal);
            sphere.userData.boneIndex = i;
            sphere.userData.sharedMaterial = true;
            sphere.renderOrder = 999;
            sphere.visible = this._shouldMarkerBeVisible(sphere);
            bone.add(sphere);
            sphere.position.set(0, 0, 0);
            this.jointMarkers.push(sphere);
        }
    }

    _initIKHelpers() {
        if (!this.ikController) this.initIK();
        if (this.ikController) this.createIKEffectorHelpers();

    }

    _hideRootToHipSkeletonSegment() {
        const helper = this.skeletonHelper;
        const hipBone = this.boneList?.find(bone => bone.name === this._centerHipBoneName);
        if (!helper || !hipBone?.parent?.isBone || helper.userData.hiddenRootHipSegment) return;

        let segmentIndex = 0;
        let targetSegmentIndex = -1;
        for (const bone of helper.bones || []) {
            if (!bone.parent?.isBone) continue;
            if (bone === hipBone) {
                targetSegmentIndex = segmentIndex;
                break;
            }
            segmentIndex += 1;
        }
        if (targetSegmentIndex < 0) return;

        const originalUpdateMatrixWorld = helper.updateMatrixWorld.bind(helper);
        helper.updateMatrixWorld = (force) => {
            originalUpdateMatrixWorld(force);
            const positions = helper.geometry.getAttribute("position");
            const first = targetSegmentIndex * 2;
            const second = first + 1;
            positions.setXYZ(second, positions.getX(first), positions.getY(first), positions.getZ(first));
            positions.needsUpdate = true;
        };
        helper.userData.hiddenRootHipSegment = true;
        helper.updateMatrixWorld(true);
    }

    updateHeadScale(scale) {
        this.headScale = scale;
        const headBone = this.boneList.find(b => b.name.toLowerCase().includes('head'));
        if (headBone) {
            headBone.scale.set(scale, scale, scale);
            this.requestRender();
        }
    }

    updateArmScale(scale) {
        this.armScale = scale;
        for (const bone of this.boneList) {
            const n = bone.name.toLowerCase();
            if (n === 'upperarm_l' || n === 'upperarm_r') {
                bone.scale.set(scale, scale, scale);
            }
        }
        this.requestRender();
    }

    updateHandScale(scale) {
        this.handScale = scale;
        for (const bone of this.boneList) {
            const n = bone.name.toLowerCase();
            if (n === 'hand_l' || n === 'hand_r') {
                bone.scale.set(scale, scale, scale);
            }
        }
        this.requestRender();
    }

    updateFootScale(scale) {
        this.footScale = scale;
        for (const bone of this.boneList) {
            const n = bone.name.toLowerCase();
            if (n === 'foot_l' || n === 'foot_r') {
                bone.scale.set(scale, scale, scale);
            }
        }
        this.requestRender();
    }

    _lengthSliderToScale(value) {
        const v = Number.isFinite(Number(value)) ? Number(value) : 0.5;
        return Math.max(0.25, Math.min(2.0, 0.5 + v));
    }

    _setBoneOffsetScale(childName, scale) {
        const bone = this.bones?.[childName];
        const initial = this.initialBoneStates?.[childName]?.position;
        if (!bone || !initial) return;
        bone.position.copy(initial).multiplyScalar(scale);
    }

    _boneLengthChildrenForGroup(group) {
        if (group === 'shoulder_l') {
            return ['upperarm_l'];
        }
        if (group === 'shoulder_r') {
            return ['upperarm_r'];
        }
        if (group === 'hip_l') {
            return ['thigh_l'];
        }
        if (group === 'hip_r') {
            return ['thigh_r'];
        }
        if (group === 'upper_arm') {
            return ['lowerarm_l', 'lowerarm_r'];
        }
        if (group === 'upper_arm_l') {
            return ['lowerarm_l'];
        }
        if (group === 'upper_arm_r') {
            return ['lowerarm_r'];
        }
        if (group === 'forearm') {
            return ['hand_l', 'hand_r'];
        }
        if (group === 'forearm_l') {
            return ['hand_l'];
        }
        if (group === 'forearm_r') {
            return ['hand_r'];
        }
        if (group === 'thigh') {
            return ['calf_l', 'calf_r'];
        }
        if (group === 'thigh_l') {
            return ['calf_l'];
        }
        if (group === 'thigh_r') {
            return ['calf_r'];
        }
        if (group === 'shin') {
            return ['foot_l', 'foot_r'];
        }
        if (group === 'shin_l') {
            return ['foot_l'];
        }
        if (group === 'shin_r') {
            return ['foot_r'];
        }
        if (group === 'spine') {
            return ['spine_02', 'spine_03'];
        }
        return [];
    }

    _cacheShapedRestBonePositions(boneNames = null) {
        if (!this.shapedBoneRestPositions) this.shapedBoneRestPositions = {};
        const names = boneNames ? new Set(boneNames) : null;
        for (const bone of this.boneList || []) {
            if (!names || names.has(bone.name)) {
                this.shapedBoneRestPositions[bone.name] = bone.position.clone();
            }
        }
    }

    updateBoneLengthScale(group, value) {
        if (!this.boneLengthParams) {
            this.boneLengthParams = {
                shoulder_l: 0.5, shoulder_r: 0.5,
                hip_l: 0.5, hip_r: 0.5,
                upper_arm_l: 0.5, upper_arm_r: 0.5,
                forearm_l: 0.5, forearm_r: 0.5,
                thigh_l: 0.5, thigh_r: 0.5,
                shin_l: 0.5, shin_r: 0.5,
                spine: 0.5,
            };
        }
        if (group === 'arm') group = 'upper_arm';
        if (group === 'leg') group = 'thigh';
        const validGroups = [
            'shoulder_l', 'shoulder_r',
            'hip_l', 'hip_r',
            'upper_arm', 'upper_arm_l', 'upper_arm_r',
            'forearm', 'forearm_l', 'forearm_r',
            'thigh', 'thigh_l', 'thigh_r',
            'shin', 'shin_l', 'shin_r',
            'spine',
        ];
        if (!validGroups.includes(group)) return;
        this.boneLengthParams[group] = Number.isFinite(Number(value)) ? Number(value) : 0.5;
        const scale = this._lengthSliderToScale(this.boneLengthParams[group]);
        const affectedChildren = this._boneLengthChildrenForGroup(group);
        for (const childName of affectedChildren) {
            this._setBoneOffsetScale(childName, scale);
        }
        for (const bone of this.boneList) bone.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();
        this._cacheShapedRestBonePositions(affectedChildren);
        this.updateIKEffectorPositions();
        this.requestRender();
    }

    applyBoneLengthScales() {
        if (!this.boneLengthParams) return;
        this.updateBoneLengthScale('shoulder_l', this.boneLengthParams.shoulder_l ?? 0.5);
        this.updateBoneLengthScale('shoulder_r', this.boneLengthParams.shoulder_r ?? 0.5);
        this.updateBoneLengthScale('hip_l', this.boneLengthParams.hip_l ?? 0.5);
        this.updateBoneLengthScale('hip_r', this.boneLengthParams.hip_r ?? 0.5);
        this.updateBoneLengthScale('upper_arm_l', this.boneLengthParams.upper_arm_l ?? this.boneLengthParams.upper_arm ?? this.boneLengthParams.arm ?? 0.5);
        this.updateBoneLengthScale('upper_arm_r', this.boneLengthParams.upper_arm_r ?? this.boneLengthParams.upper_arm ?? this.boneLengthParams.arm ?? 0.5);
        this.updateBoneLengthScale('forearm_l', this.boneLengthParams.forearm_l ?? this.boneLengthParams.forearm ?? this.boneLengthParams.arm ?? 0.5);
        this.updateBoneLengthScale('forearm_r', this.boneLengthParams.forearm_r ?? this.boneLengthParams.forearm ?? this.boneLengthParams.arm ?? 0.5);
        this.updateBoneLengthScale('thigh_l', this.boneLengthParams.thigh_l ?? this.boneLengthParams.thigh ?? this.boneLengthParams.leg ?? 0.5);
        this.updateBoneLengthScale('thigh_r', this.boneLengthParams.thigh_r ?? this.boneLengthParams.thigh ?? this.boneLengthParams.leg ?? 0.5);
        this.updateBoneLengthScale('shin_l', this.boneLengthParams.shin_l ?? this.boneLengthParams.shin ?? this.boneLengthParams.leg ?? 0.5);
        this.updateBoneLengthScale('shin_r', this.boneLengthParams.shin_r ?? this.boneLengthParams.shin ?? this.boneLengthParams.leg ?? 0.5);
        this.updateBoneLengthScale('spine', this.boneLengthParams.spine ?? 0.5);
    }

    setSkinTexture(skinType) {
        this.currentSkinType = skinType;
        if (!this.skinnedMesh) return;

        // Check configuration bypass flags to protect embedding apps (e.g WebGL Error Contexts)
        if (!this.options.enableTextureSkinning || this.options.skinMode === 'flat_color') {
            // Maps are cache-owned and may still be referenced by a passive
            // rig. Detach them from every character without disposing here.
            this._applyTextureToAllCharacters(null);
            this._skinTextureLoadToken += 1;
            this._markSkinTextureReady();
            return;
        }

        if (
            this._cachedSkinTextureReady
            && this.cachedSkinTexture
            && this.cachedSkinType === skinType
        ) {
            this._applyTextureToAllCharacters(this.cachedSkinTexture);
            this._skinTextureLoadToken += 1;
            this._markSkinTextureReady();
            return;
        }

        this._loadSkinTexture(skinType, (tex) => {
            this._applyTextureToAllCharacters(tex);
        });
    }

    // === Pose State Management ===

    getPose() {
        const bones = {};
        const bonePositions = {};
        for (const b of this.boneList) {
            const rot = b.rotation;
            if (Math.abs(rot.x) > 1e-4 || Math.abs(rot.y) > 1e-4 || Math.abs(rot.z) > 1e-4) {
                bones[b.name] = [
                    rot.x * 180 / Math.PI,
                    rot.y * 180 / Math.PI,
                    rot.z * 180 / Math.PI
                ];
            }
            const shapedRest = this.shapedBoneRestPositions?.[b.name];
            const initialRest = this.initialBoneStates?.[b.name]?.position;
            const restPosition = shapedRest || initialRest;
            if (restPosition && (b.position.distanceToSquared(restPosition) > 1e-10
                || !b.userData.parentName || !this.bones[b.userData.parentName])) {
                bonePositions[b.name] = [b.position.x, b.position.y, b.position.z];
            }
        }

        // Save IK effector positions
        const ikEffectorPositions = {};
        if (this.ikController) {
            for (const [name, effector] of Object.entries(this.ikController.effectors)) {
                ikEffectorPositions[name] = [effector.position.x, effector.position.y, effector.position.z];
            }
        }

        // Save pole target positions
        const poleTargetPositions = {};
        if (this.ikController) {
            for (const [chainKey, pole] of Object.entries(this.ikController.poleTargets)) {
                poleTargetPositions[chainKey] = [pole.position.x, pole.position.y, pole.position.z];
            }
        }

        // Save hip bone position (for hips IK)
        const hipBonePosition = {};
        if (this.initialBoneStates) {
            for (const chainKey of Object.keys(IK_CHAINS)) {
                const chainDef = IK_CHAINS[chainKey];
                if (chainDef.isRoot && chainDef.effector) {
                    const hipBone = this.bones[chainDef.effector];
                    if (hipBone) {
                        hipBonePosition[chainKey] = [hipBone.position.x, hipBone.position.y, hipBone.position.z];
                    }
                }
            }
        }

        return {
            bones,
            // SAM IK may translate joint roots (notably the two hip sockets).
            // These local offsets are pose data and must survive editor commit.
            bonePositions,
            modelRotation: [this.modelRotation.x, this.modelRotation.y, this.modelRotation.z],
            camera: {
                posX: this.camera.position.x,
                posY: this.camera.position.y,
                posZ: this.camera.position.z,
                targetX: this.orbit.target.x,
                targetY: this.orbit.target.y,
                targetZ: this.orbit.target.z
            },
            // Store widget-side camera params too!
            cameraParams: this.cameraParams,
            // IK effector positions
            ikEffectorPositions,
            // Pole target positions
            poleTargetPositions,
            // Hip bone positions (for undo)
            hipBonePosition
        };
    }

    getHistoryPose() {
        const pose = this.getPose();
        const editorState = this.options?.captureHistoryContext?.();
        return editorState ? { ...pose, editorState } : pose;
    }

    recordState() {
        const state = this.getHistoryPose();
        // Avoid duplicate states if possible, but for drag start it's fine
        this.history.push(JSON.stringify(state));
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }
        this.future = []; // Clear redo stack on new action
    }

    undo() {
        if (this.history.length === 0) return;

        const current = JSON.stringify(this.getHistoryPose());
        this.future.push(current);

        const prev = JSON.parse(this.history.pop());
        this.setPose(prev);
        this.options?.onHistoryRestore?.(prev);

        // Sync after undo
        if (this.syncCallback) this.syncCallback();
        else this.dispatchPoseChange();
    }

    redo() {
        if (this.future.length === 0) return;

        const current = JSON.stringify(this.getHistoryPose());
        this.history.push(current);

        const next = JSON.parse(this.future.pop());
        this.setPose(next);
        this.options?.onHistoryRestore?.(next);

        // Sync after redo
        if (this.syncCallback) this.syncCallback();
        else this.dispatchPoseChange();
    }

    setPose(pose, preserveCamera = false) {
        if (!pose) return;

        const bones = pose.bones || {};
        const bonePositions = pose.bonePositions || {};
        const modelRot = pose.modelRotation || [0, 0, 0];
        const ikPositions = pose.ikEffectorPositions || {};

        // Reset all bones
        for (const b of this.boneList) {
            b.rotation.set(0, 0, 0);
            const shapedRest = this.shapedBoneRestPositions?.[b.name];
            const initialRest = this.initialBoneStates?.[b.name]?.position;
            if (shapedRest) b.position.copy(shapedRest);
            else if (initialRest) b.position.copy(initialRest);
        }

        // Apply bone rotations
        for (const [bName, rot] of Object.entries(bones)) {
            const bone = this.bones[bName];
            if (bone && Array.isArray(rot) && rot.length >= 3) {
                bone.rotation.set(
                    rot[0] * Math.PI / 180,
                    rot[1] * Math.PI / 180,
                    rot[2] * Math.PI / 180
                );
            }
        }

        // Restore pose translations after resetting to the shaped skeleton.
        // A body-shape edit removes this field before pose reapplication.
        for (const [bName, position] of Object.entries(bonePositions)) {
            const bone = this.bones[bName];
            if (!bone || !Array.isArray(position) || position.length < 3) continue;
            const values = position.slice(0, 3).map(Number);
            if (values.every(Number.isFinite)) bone.position.set(values[0], values[1], values[2]);
        }

        // Apply model rotation
        this.modelRotation.x = modelRot[0] || 0;
        this.modelRotation.y = modelRot[1] || 0;
        this.modelRotation.z = modelRot[2] || 0;

        if (this.skinnedMesh) {
            this.skinnedMesh.rotation.set(
                this.modelRotation.x * Math.PI / 180,
                this.modelRotation.y * Math.PI / 180,
                this.modelRotation.z * Math.PI / 180
            );
        }

        // Camera handling - skip if preserveCamera is true (e.g. library loading)
        if (!preserveCamera) {
            if (pose.camera) {
                this.camera.position.set(
                    pose.camera.posX,
                    pose.camera.posY,
                    pose.camera.posZ
                );
                this.orbit.target.set(
                    pose.camera.targetX,
                    pose.camera.targetY,
                    pose.camera.targetZ
                );
            } else {
                // Default view if no camera data (prevents inheriting from previous tab)
                this.camera.position.set(0, 0.5, 4);
                this.orbit.target.set(0, 1, 0);
            }
            this.orbit.update();
        }

        if (this.cameraParams) {
            this.cameraParams = { ...this.cameraParams, ...pose.cameraParams };
        } else {
            this.cameraParams = pose.cameraParams;
        }

        // Restore IK effector positions
        if (this.ikController && ikPositions) {
            for (const [name, pos] of Object.entries(ikPositions)) {
                const effector = this.ikController.effectors[name];
                if (effector && Array.isArray(pos) && pos.length >= 3) {
                    effector.position.set(pos[0], pos[1], pos[2]);
                }
            }
        }

        // Restore pole target positions
        const polePositions = pose.poleTargetPositions || {};
        if (this.ikController && polePositions) {
            for (const [chainKey, pos] of Object.entries(polePositions)) {
                const pole = this.ikController.poleTargets[chainKey];
                if (pole && Array.isArray(pos) && pos.length >= 3) {
                    pole.position.set(pos[0], pos[1], pos[2]);
                }
            }
        }

        // Restore hip bone positions
        const hipPositions = pose.hipBonePosition || {};
        for (const [chainKey, pos] of Object.entries(hipPositions)) {
            const chainDef = IK_CHAINS[chainKey];
            if (chainDef && chainDef.effector && Array.isArray(pos) && pos.length >= 3) {
                const hipBone = this.bones[chainDef.effector];
                if (hipBone) {
                    hipBone.position.set(pos[0], pos[1], pos[2]);
                    hipBone.updateMatrixWorld(true);
                }
            }
        }

        // Update skeleton after all changes
        this.skinnedMesh?.updateMatrixWorld?.(true);
        if (this.skeleton) {
            this.skeleton.update();
        }

        this.requestRender();
    }

    setCameraParams(params) {
        if (!params) return;
        if (this.cameraParams) {
            this.cameraParams = { ...this.cameraParams, ...params };
        } else {
            this.cameraParams = params;
        }
    }

    setViewportView(view, { fit = true, animate = false } = {}) {
        if (!this.camera || !this.orbit || !this.THREE) return false;
        const directions = {
            front: editorAxisVector(this.THREE, "Y"),
            left: editorAxisVector(this.THREE, "X", -1),
            right: editorAxisVector(this.THREE, "X"),
            back: editorAxisVector(this.THREE, "Y", -1),
            top: editorAxisVector(this.THREE, "Z"),
            bottom: editorAxisVector(this.THREE, "Z", -1),
        };
        const direction = directions[view];
        if (!direction) return false;

        const target = (this.captureFrame?.visible
            ? this.captureFrame.position
            : (this.sceneCameraTarget || this.orbit.target)).clone();
        const distance = Math.max(1, this.camera.position.distanceTo(target));
        const targetUp = editorAxisVector(this.THREE, "Z");
        if (view === "top") targetUp.copy(editorAxisVector(this.THREE, "Y", -1));
        else if (view === "bottom") targetUp.copy(editorAxisVector(this.THREE, "Y"));
        const destination = direction.clone().multiplyScalar(distance).add(target);
        if (animate) return this._animateViewportSnap(destination, target, targetUp);
        this.camera.up.copy(targetUp);
        this.camera.position.copy(destination);
        this.camera.lookAt(target);
        this.orbit.target.copy(target);
        this.orbit.update();
        if (fit) {
            this.fitCaptureFrameInViewport?.({
                margin: 0.96,
                insets: { left: 0.025, right: 0.025, top: 0.16, bottom: 0.035 },
            });
        }
        this.requestRender();
        return true;
    }

    snapToNearestViewportView() {
        if (!this.camera || !this.orbit || !this.THREE) return false;
        // Keep the current orbit pivot and camera distance so snapping changes
        // orientation only; orthographic camera.zoom is left untouched too.
        const target = this.orbit.target.clone();
        const direction = this.camera.position.clone().sub(target).normalize();
        const candidates = [
            editorAxisVector(this.THREE, "Y"),
            editorAxisVector(this.THREE, "Y", -1),
            editorAxisVector(this.THREE, "X", -1),
            editorAxisVector(this.THREE, "X"),
            editorAxisVector(this.THREE, "Z"),
            editorAxisVector(this.THREE, "Z", -1),
        ];
        let nearest = candidates[0];
        let nearestDot = -Infinity;
        for (const candidate of candidates) {
            const dot = direction.dot(candidate);
            if (dot > nearestDot) {
                nearest = candidate;
                nearestDot = dot;
            }
        }
        if (Math.abs(nearest.dot(editorAxisVector(this.THREE, "Z"))) > 0.5) {
            let nearestSide = candidates[0];
            let nearestSideDot = direction.dot(nearestSide);
            for (let index = 1; index < 4; index += 1) {
                const dot = direction.dot(candidates[index]);
                if (dot > nearestSideDot) {
                    nearestSide = candidates[index];
                    nearestSideDot = dot;
                }
            }
            // Avoid flipping between a side and top/bottom view at their
            // diagonal boundary due to tiny pointer or floating-point changes.
            if (nearestSideDot >= nearestDot - 0.08) nearest = nearestSide;
        }
        const distance = Math.max(1, this.camera.position.distanceTo(target));
        const destination = target.clone().addScaledVector(nearest, distance);
        // Build the valid horizontal/vertical roll choices by aligning any
        // visible world axis with screen-right or screen-up. Pick the choice
        // closest to the current camera orientation, including its sign, so
        // axes that already point left/up remain that way after snapping.
        const currentRight = new this.THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
        const currentUp = this.camera.up.clone().normalize();
        const axisVectors = [
            editorAxisVector(this.THREE, "X"),
            editorAxisVector(this.THREE, "Y"),
            editorAxisVector(this.THREE, "Z"),
        ];
        const rollChoices = [];
        for (const axis of axisVectors) {
            const projected = axis.addScaledVector(nearest, -axis.dot(nearest));
            if (projected.lengthSq() <= 0.01) continue;
            const screenAxis = projected.normalize();
            const rightAlignedUp = nearest.clone().cross(screenAxis).normalize();
            const upAlignedRight = screenAxis.clone().cross(nearest).normalize();
            for (const sign of [1, -1]) {
                rollChoices.push({
                    right: screenAxis.clone().multiplyScalar(sign),
                    up: rightAlignedUp.clone().multiplyScalar(sign),
                });
                rollChoices.push({
                    right: upAlignedRight.clone().multiplyScalar(sign),
                    up: screenAxis.clone().multiplyScalar(sign),
                });
            }
        }

        const directionSwing = new this.THREE.Quaternion().setFromUnitVectors(direction, nearest);
        let targetUp = this.camera.up.clone().applyQuaternion(directionSwing);
        targetUp.addScaledVector(nearest, -targetUp.dot(nearest)).normalize();
        let bestScore = -Infinity;
        for (const choice of rollChoices) {
            const score = choice.right.dot(currentRight) + choice.up.dot(currentUp);
            if (score > bestScore) {
                bestScore = score;
                targetUp = choice.up;
            }
        }
        return this._animateViewportSnap(destination, target.clone(), targetUp);
    }

    _animateViewportSnap(destination, target, targetUp, duration = 260) {
        const THREE = this.THREE;
        if (this._viewportSnapAnimationFrame != null) {
            cancelAnimationFrame(this._viewportSnapAnimationFrame);
            this._viewportSnapAnimationFrame = null;
        }
        const startPosition = this.camera.position.clone();
        const startDirection = startPosition.clone().sub(target).normalize();
        const endDirection = destination.clone().sub(target).normalize();
        const rotation = new THREE.Quaternion().setFromUnitVectors(startDirection, endDirection);
        const identity = new THREE.Quaternion();
        const startUp = this.camera.up.clone().normalize();
        const endUp = targetUp.clone().normalize();
        const startTime = performance.now();
        const previousOrbitEnabled = this._viewportSnapPreviousOrbitEnabled ?? this.orbit.enabled;
        this._viewportSnapPreviousOrbitEnabled = previousOrbitEnabled;
        this.orbit.enabled = false;
        this.orbit.target.copy(target);

        const animateFrame = now => {
            const linear = Math.min(1, Math.max(0, (now - startTime) / duration));
            const eased = linear * linear * (3 - 2 * linear);
            const arcRotation = identity.clone().slerp(rotation, eased);
            const direction = startDirection.clone().applyQuaternion(arcRotation).normalize();
            this.camera.position.copy(target).addScaledVector(direction, destination.distanceTo(target));
            this.camera.up.copy(startUp).lerp(endUp, eased).normalize();
            this.camera.lookAt(target);
            this.requestRender();

            if (linear < 1) {
                this._viewportSnapAnimationFrame = requestAnimationFrame(animateFrame);
                return;
            }

            this._viewportSnapAnimationFrame = null;
            this.camera.position.copy(destination);
            this.camera.up.copy(endUp);
            this.camera.lookAt(target);
            this.orbit.enabled = previousOrbitEnabled;
            this._viewportSnapPreviousOrbitEnabled = null;
            this.orbit.update();
            this.requestRender();
        };

        this._viewportSnapAnimationFrame = requestAnimationFrame(animateFrame);
        return true;
    }

    resetPose() {
        for (const b of this.boneList) {
            b.rotation.set(0, 0, 0);

            // Reset bone position to initial state (important for hips IK)
            if (this.initialBoneStates && this.initialBoneStates[b.name]) {
                const initialState = this.initialBoneStates[b.name];
                b.position.copy(initialState.position);
            }
        }

        // Update matrix world after position/rotation changes
        for (const b of this.boneList) {
            b.updateMatrixWorld(true);
        }
        this.applyBoneLengthScales();

        this.modelRotation = { x: 0, y: 0, z: 0 };
        if (this.skinnedMesh) {
            this.skinnedMesh.rotation.set(0, 0, 0);
        }

        // Update skeleton
        if (this.skeleton) {
            this.skeleton.update();
        }

        // Reset IK effector positions to match bones
        this.updateIKEffectorPositions();

        this.requestRender();
    }

    resetSelectedBone() {
        if (!this.selectedBone) return;

        this.recordState();

        // Reset the selected bone's rotation
        this.selectedBone.rotation.set(0, 0, 0);

        // Reset position to initial state (important for hips IK)
        if (this.initialBoneStates && this.initialBoneStates[this.selectedBone.name]) {
            const initialState = this.initialBoneStates[this.selectedBone.name];
            this.selectedBone.position.copy(initialState.position);
        }

        this.selectedBone.updateMatrixWorld(true);

        // Update skeleton
        if (this.skeleton) {
            this.skeleton.update();
        }

        // Update IK effector positions since bone changed
        this.updateIKEffectorPositions();

        this.requestRender();
    }

    interpolateFingerPose(poseA, poseB, t, side, fingerPrefix, bias = [1, 1, 1]) {
        if (!this.boneList) return;
        const dataA = side === "r" ? poseA.preset_r : poseA.preset_l;
        const dataB = side === "r" ? poseB.preset_r : poseB.preset_l;
        if (!dataA || !dataB) return;

        const THREE = this.THREE;
        const qa = new THREE.Quaternion();
        const qb = new THREE.Quaternion();

        for (const [index, segment] of ["01", "02", "03"].entries()) {
            const bone = this.bones[`${fingerPrefix}_${segment}_${side}`];
            if (!bone) continue;
            const a = dataA[`${fingerPrefix}_${segment}`];
            const b = dataB[`${fingerPrefix}_${segment}`];
            if (!a || !b) continue;
            qa.set(a[0], a[1], a[2], a[3]);
            qb.set(b[0], b[1], b[2], b[3]);
            bone.quaternion.slerpQuaternions(qa, qb, Math.min(1.2, Math.max(-0.2, t * bias[index])));
            bone.quaternion.normalize();
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            bone.updateMatrixWorld(true);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
    }

    interpolateHandPose(poseA, poseB, t, side) {
        if (!this.boneList) return;

        const dataA = side === "r" ? poseA.preset_r : poseA.preset_l;
        const dataB = side === "r" ? poseB.preset_r : poseB.preset_l;
        if (!dataA || !dataB) return;

        const THREE = this.THREE;
        const qa = new THREE.Quaternion();
        const qb = new THREE.Quaternion();

        for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
            for (const segment of ["01", "02", "03"]) {
                const bone = this.bones[`${prefix}_${segment}_${side}`];
                if (!bone) continue;
                const a = dataA[`${prefix}_${segment}`];
                const b = dataB[`${prefix}_${segment}`];
                if (!a || !b) continue;
                qa.set(a[0], a[1], a[2], a[3]);
                qb.set(b[0], b[1], b[2], b[3]);
                bone.quaternion.slerpQuaternions(qa, qb, t);
                bone.quaternion.normalize();
                bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
                bone.updateMatrixWorld(true);
            }
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
    }

    applyHandPresetPreview(presetData, side) {
        if (!this.boneList || !presetData) return;

        const applySide = (targetSide, data) => {
            if (!data) return;
            for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
                for (const segment of ["01", "02", "03"]) {
                    const bone = this.bones[`${prefix}_${segment}_${targetSide}`];
                    if (!bone) continue;
                    const quaternion = data[`${prefix}_${segment}`];
                    if (!quaternion) continue;
                    bone.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
                    bone.quaternion.normalize();
                    bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
                    bone.updateMatrixWorld(true);
                }
            }
        };

        if (presetData.preset_l || presetData.preset_r) {
            if (side === "both") {
                applySide("l", presetData.preset_l);
                applySide("r", presetData.preset_r);
            } else if (side === "l") {
                applySide("l", presetData.preset_l);
            } else if (side === "r") {
                applySide("r", presetData.preset_r);
            }
        } else if (side === "both") {
            applySide("l", presetData);
            applySide("r", presetData);
        } else {
            applySide(side, presetData);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
    }

    saveHandSnapshot() {
        const snapshot = {};
        for (const side of ["l", "r"]) {
            for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
                for (const segment of ["01", "02", "03"]) {
                    const bone = this.bones[`${prefix}_${segment}_${side}`];
                    if (!bone) continue;
                    snapshot[`${prefix}_${segment}_${side}`] = [bone.rotation.x, bone.rotation.y, bone.rotation.z];
                }
            }
        }
        this._handSnapshot = snapshot;
    }

    restoreHandSnapshot() {
        if (!this._handSnapshot) return;
        for (const [boneName, rotation] of Object.entries(this._handSnapshot)) {
            const bone = this.bones[boneName];
            if (!bone) continue;
            bone.rotation.set(rotation[0], rotation[1], rotation[2]);
            bone.quaternion.setFromEuler(bone.rotation);
            bone.updateMatrixWorld(true);
        }
        this._handSnapshot = null;
        if (this.skeleton) this.skeleton.update();
        this.updateMarkers();
        this.requestRender();
    }

    applyHandPreset(side, presetData) {
        if (!this.boneList || !presetData) return;
        this.recordState();

        const applySide = (targetSide, data) => {
            if (!data) return;
            for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
                for (const segment of ["01", "02", "03"]) {
                    const bone = this.bones[`${prefix}_${segment}_${targetSide}`];
                    if (!bone) continue;
                    const quaternion = data[`${prefix}_${segment}`];
                    if (!quaternion) continue;
                    bone.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
                    bone.quaternion.normalize();
                    bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
                    bone.updateMatrixWorld(true);
                }
            }
        };

        if (presetData.preset_l || presetData.preset_r) {
            if (side === "both") {
                applySide("l", presetData.preset_l);
                applySide("r", presetData.preset_r);
            } else if (side === "l") {
                applySide("l", presetData.preset_l);
            } else if (side === "r") {
                applySide("r", presetData.preset_r);
            }
        } else if (side === "both") {
            applySide("l", presetData);
            applySide("r", presetData);
        } else {
            applySide(side, presetData);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
        this.dispatchPoseChange();
    }

    captureHandPreset(side) {
        const captureSide = (targetSide) => {
            const data = {};
            for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
                for (const segment of ["01", "02", "03"]) {
                    const bone = this.bones[`${prefix}_${segment}_${targetSide}`];
                    if (!bone) continue;
                    const quaternion = bone.quaternion;
                    data[`${prefix}_${segment}`] = [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
                }
            }
            return data;
        };

        const canonical = captureSide(side);
        const mirrored = {};
        for (const [key, quaternion] of Object.entries(canonical)) {
            mirrored[key] = [-quaternion[0], quaternion[1], quaternion[2], -quaternion[3]];
        }

        return {
            source_side: side,
            preset_l: side === "l" ? canonical : mirrored,
            preset_r: side === "r" ? canonical : mirrored,
        };
    }

    _getHandMarkers(side) {
        const handBoneNames = new Set([
            "hand_l", "thumb_01_l", "thumb_02_l", "thumb_03_l", "index_01_l", "index_02_l", "index_03_l",
            "middle_01_l", "middle_02_l", "middle_03_l", "ring_01_l", "ring_02_l", "ring_03_l",
            "pinky_01_l", "pinky_02_l", "pinky_03_l",
            "hand_r", "thumb_01_r", "thumb_02_r", "thumb_03_r", "index_01_r", "index_02_r", "index_03_r",
            "middle_01_r", "middle_02_r", "middle_03_r", "ring_01_r", "ring_02_r", "ring_03_r",
            "pinky_01_r", "pinky_02_r", "pinky_03_r",
        ]);

        return this.jointMarkers.filter((marker) => {
            const bone = this.boneList[marker.userData.boneIndex];
            if (!bone || !handBoneNames.has(bone.name)) return false;
            if (side === "both") return true;
            return bone.name.endsWith(`_${side}`);
        });
    }

    showHandHighlightRing(side) {
        this.hideHandHighlightRing();
        const THREE = this.THREE;
        const sides = side === "both" ? ["l", "r"] : [side];
        this._handRings = [];

        for (const currentSide of sides) {
            const handBone = this.bones[`hand_${currentSide}`];
            if (!handBone) continue;

            const centerBone = this.bones[`middle_01_${currentSide}`] || handBone;
            const handPosition = new THREE.Vector3();
            centerBone.getWorldPosition(handPosition);

            let maxDistance = 0.1;
            for (const tip of ["thumb_03", "index_03", "middle_03", "ring_03", "pinky_03"]) {
                const bone = this.bones[`${tip}_${currentSide}`];
                if (!bone) continue;
                const position = new THREE.Vector3();
                bone.getWorldPosition(position);
                maxDistance = Math.max(maxDistance, handPosition.distanceTo(position));
            }

            const sphere = new THREE.Mesh(
                new THREE.SphereGeometry(maxDistance * 1.3, 16, 12),
                new THREE.MeshBasicMaterial({
                    color: 0xffd666,
                    transparent: true,
                    opacity: 0.18,
                    depthTest: false,
                    side: THREE.FrontSide,
                })
            );
            sphere.position.copy(handPosition);
            sphere.renderOrder = 998;
            sphere.onBeforeRender = () => {
                centerBone.getWorldPosition(sphere.position);
            };

            this.scene.add(sphere);
            this._handRings.push(sphere);
        }

        this.requestRender();
    }

    hideHandHighlightRing() {
        if (!this._handRings) return;
        for (const ring of this._handRings) {
            ring.geometry.dispose();
            ring.material.dispose();
            this.scene.remove(ring);
        }
        this._handRings = null;
        this.requestRender();
    }

    highlightHandMarkers(side) {
        this.unhighlightHandMarkers();
        this._highlightedMarkers = this._getHandMarkers(side);
        this._highlightedMarkers.forEach((marker) => {
            marker.material = marker.material.clone();
            marker.material.color.setHex(0x00ffff);
        });
        this.requestRender();
    }

    unhighlightHandMarkers() {
        if (!this._highlightedMarkers) return;
        this._highlightedMarkers.forEach((marker) => {
            marker.material.dispose();
            marker.material = this.markerMatNormal;
        });
        this._highlightedMarkers = null;
        this.updateMarkers();
        this.requestRender();
    }

    flashHandMarkers(side) {
        this.highlightHandMarkers(side);
        setTimeout(() => this.unhighlightHandMarkers(), 400);
    }

    setModelRotation(x, y, z) {
        this.modelRotation.x = x !== undefined ? x : this.modelRotation.x;
        this.modelRotation.y = y !== undefined ? y : this.modelRotation.y;
        this.modelRotation.z = z !== undefined ? z : this.modelRotation.z;

        if (this.skinnedMesh) {
            this.skinnedMesh.rotation.set(
                this.modelRotation.x * Math.PI / 180,
                this.modelRotation.y * Math.PI / 180,
                this.modelRotation.z * Math.PI / 180
            );
        }

        // Changing model rotation changes effector world positions
        if (this.ikController) {
            this.updateIKEffectorPositions();
        }

        this.requestRender();
    }

    _normalizedCharacterTransform(transform = {}) {
        const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
        return {
            x: Math.max(-50, Math.min(50, finite(transform.x ?? transform.offset_x, 0))),
            y: Math.max(-50, Math.min(50, finite(transform.y ?? transform.offset_y, 0))),
            z: Math.max(-40, Math.min(40, finite(transform.z ?? transform.depth, 0))),
            zoom: Math.max(0.1, Math.min(7, finite(transform.zoom ?? transform.scale, 1))),
        };
    }

    _normalizedCharacterColor(color) {
        const text = String(color || "").trim();
        if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
        if (/^#[0-9a-f]{3}$/i.test(text)) {
            return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
        }
        return "#ffffff";
    }

    _applyCharacterTransform(mesh, transform = {}) {
        if (!mesh) return;
        const normalized = this._normalizedCharacterTransform(transform);
        mesh.position.set(normalized.x, normalized.y, normalized.z);
        mesh.scale.setScalar(normalized.zoom);
        mesh.updateMatrixWorld(true);
    }

    _configureHorizonFadeMaterial(material) {
        if (!material) return;
        const materials = Array.isArray(material) ? material : [material];
        for (const item of materials) {
            if (!item || !this.THREE) continue;
            const uniforms = {
                plane: { value: new this.THREE.Vector4(0, 1, 0, 0) },
                fadeWidth: { value: 0.1 },
                enabled: { value: 1 },
            };
            const originalCompile = item.onBeforeCompile;
            item.transparent = true;
            item.onBeforeCompile = shader => {
                originalCompile?.call(item, shader, this.renderer);
                shader.uniforms.uPoseHorizonPlane = uniforms.plane;
                shader.uniforms.uPoseHorizonFadeWidth = uniforms.fadeWidth;
                shader.uniforms.uPoseHorizonFadeEnabled = uniforms.enabled;
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <common>',
                    '#include <common>\nvarying vec3 vPoseStudioWorldPosition;'
                ).replace(
                    '#include <project_vertex>',
                    'vPoseStudioWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>'
                );
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <common>',
                    '#include <common>\nvarying vec3 vPoseStudioWorldPosition;\nuniform vec4 uPoseHorizonPlane;\nuniform float uPoseHorizonFadeWidth;\nuniform float uPoseHorizonFadeEnabled;'
                ).replace(
                    '#include <dithering_fragment>',
                    `
                    float poseHorizonDistance = dot(uPoseHorizonPlane.xyz, vPoseStudioWorldPosition) + uPoseHorizonPlane.w;
                    float poseHorizonBlend = smoothstep(-uPoseHorizonFadeWidth, uPoseHorizonFadeWidth, poseHorizonDistance);
                    float poseBelowHorizon = 1.0 - poseHorizonBlend;
                    float poseBelowHorizonAlpha = mix(0.92, 1.0, poseHorizonBlend);
                    gl_FragColor.a *= mix(1.0, poseBelowHorizonAlpha, uPoseHorizonFadeEnabled);
                    vec3 poseBoundaryTint = vec3(1.0, 0.62, 0.12);
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, poseBoundaryTint, poseBelowHorizon * 0.88 * uPoseHorizonFadeEnabled);
                    #include <dithering_fragment>
                    float rim = 1.0 - abs(vNormal.z);
                    gl_FragColor.rgb *= (1.0 - pow(rim, 3.0) * 0.4);
                    `
                );
            };
            item.userData.__poseStudioHorizonFadeUniforms = uniforms;
            item.needsUpdate = true;
        }
        this._updateHorizonFadeUniforms();
    }

    _updateHorizonFadeUniforms() {
        if (!this.captureFrame || !this.THREE) return;
        this.captureFrame.updateMatrixWorld(true);
        const normal = new this.THREE.Vector3(0, 1, 0).transformDirection(this.captureFrame.matrixWorld);
        const point = new this.THREE.Vector3(0, -1, 0).applyMatrix4(this.captureFrame.matrixWorld);
        const plane = new this.THREE.Vector4(normal.x, normal.y, normal.z, -normal.dot(point));
        const fadeWidth = Math.max(0.0005, this.captureFrame.scale.y * 0.001);
        const updateMaterial = material => {
            const materials = Array.isArray(material) ? material : [material];
            for (const item of materials) {
                const uniforms = item?.userData?.__poseStudioHorizonFadeUniforms;
                if (!uniforms) continue;
                uniforms.plane.value.copy(plane);
                uniforms.fadeWidth.value = fadeWidth;
            }
        };
        updateMaterial(this.skinnedMesh?.material);
        for (const entry of this.passiveCharacters?.values?.() || []) updateMaterial(entry.mesh?.material);
    }

    _setHorizonFadeEnabled(enabled) {
        const updateMaterial = material => {
            const materials = Array.isArray(material) ? material : [material];
            for (const item of materials) {
                const uniforms = item?.userData?.__poseStudioHorizonFadeUniforms;
                if (uniforms) uniforms.enabled.value = enabled ? 1 : 0;
            }
        };
        updateMaterial(this.skinnedMesh?.material);
        for (const entry of this.passiveCharacters?.values?.() || []) updateMaterial(entry.mesh?.material);
    }

    _applyMaterialCharacterColor(material, color) {
        if (!material) return;
        if (this._multiCharacterSelection && !this._capturingOriginalCharacterColors) {
            const selected = this.options?.getCharacterSelection?.() || [];
            const highlighted = selected.some(character => {
                const mesh = character.active ? this.skinnedMesh : this.passiveCharacters?.get(String(character.id))?.mesh;
                return mesh?.material === material;
            });
            if (highlighted) color = "#ffd45e";
        }
        const normalized = this._normalizedCharacterColor(color);
        const materials = Array.isArray(material) ? material : [material];
        for (const item of materials) {
            item?.color?.set?.(normalized);
            if (item) item.needsUpdate = true;
        }
    }

    setMultiCharacterSelection(enabled, hasSelection = true) {
        this._multiCharacterSelection = !!enabled;
        this._noCharacterSelection = !hasSelection;
        const hideHelpers = enabled || !hasSelection;
        this.refreshCharacterSelectionColors();
        if (this.skeletonHelper) this.skeletonHelper.visible = !hideHelpers && this._mannequinVisible !== false;
        for (const marker of this.jointMarkers || []) {
            marker.visible = this._mannequinVisible !== false && this._shouldMarkerBeVisible(marker);
        }
        if (this.transform) this.transform.visible = !hideHelpers && this._mannequinVisible !== false && !!this.transform.object;
        if (hideHelpers) {
            for (const ring of this._handRings || []) ring.visible = false;
        }
        this._updateCharacterRotationGuide();
        this.requestRender();
    }

    refreshCharacterSelectionColors() {
        this._applyActiveCharacterColor();
        for (const entry of this.passiveCharacters?.values() || []) this._applyMaterialCharacterColor(entry.mesh?.material, entry.color);
    }

    _applyActiveCharacterColor() {
        if (!this.skinnedMesh?.material) return;
        this._applyMaterialCharacterColor(
            this.skinnedMesh.material,
            this.activeCharacterAppearance?.color,
        );
    }

    _setCharacterMaterialTexture(material, texture) {
        const materials = Array.isArray(material) ? material : [material];
        for (const item of materials) {
            if (!item) continue;
            item.map = texture || null;
            item.needsUpdate = true;
        }
    }

    _applyTextureToAllCharacters(texture) {
        this._setCharacterMaterialTexture(this.skinnedMesh?.material, texture);
        this._applyActiveCharacterColor();
        for (const entry of this.passiveCharacters?.values?.() || []) {
            this._setCharacterMaterialTexture(entry.mesh?.material, texture);
            this._applyMaterialCharacterColor(entry.mesh?.material, entry.color);
        }
        this.requestRender();
    }

    setActiveCharacterAppearance({ color, transform } = {}) {
        const current = this.activeCharacterAppearance || {};
        this.activeCharacterAppearance = {
            color: this._normalizedCharacterColor(color ?? current.color),
            transform: this._normalizedCharacterTransform(transform ?? current.transform),
        };
        this._applyActiveCharacterColor();
        this._applyCharacterTransform(this.skinnedMesh, this.activeCharacterAppearance.transform);
        this.updateIKEffectorPositions?.();
        this.updateMarkers?.();
        this.requestRender();
    }

    resetSceneCameraTarget() {
        this.sceneCameraTarget = null;
    }

    _disposePassiveCharacter(entry) {
        if (!entry) return;
        entry.skeleton?.dispose?.();
        if (entry.mesh?.parent) entry.mesh.parent.remove(entry.mesh);
        entry.mesh?.geometry?.dispose?.();
        const materials = Array.isArray(entry.mesh?.material)
            ? entry.mesh.material
            : [entry.mesh?.material];
        for (const material of materials) material?.dispose?.();
    }

    removePassiveCharacter(id) {
        const key = String(id || "");
        const entry = this.passiveCharacters?.get(key);
        if (!entry) return false;
        this._disposePassiveCharacter(entry);
        this.passiveCharacters.delete(key);
        this.requestRender();
        return true;
    }

    clearPassiveCharacters() {
        if (!this.passiveCharacters) return;
        for (const entry of this.passiveCharacters.values()) {
            this._disposePassiveCharacter(entry);
        }
        this.passiveCharacters.clear();
        this.requestRender?.();
    }

    _cloneActiveRigForPassiveCharacter(id) {
        if (!this.THREE || !this.scene || !this.skinnedMesh || !this.skeleton) return null;
        const THREE = this.THREE;
        const cloneBySource = new Map();
        const clonedBones = this.boneList.map(source => {
            const bone = new THREE.Bone();
            bone.name = source.name;
            bone.position.copy(source.position);
            bone.quaternion.copy(source.quaternion);
            bone.scale.copy(source.scale);
            bone.rotation.order = source.rotation.order;
            bone.userData = { ...source.userData };
            cloneBySource.set(source, bone);
            return bone;
        });

        const roots = [];
        for (const source of this.boneList) {
            const cloned = cloneBySource.get(source);
            const clonedParent = cloneBySource.get(source.parent);
            if (clonedParent) clonedParent.add(cloned);
            else roots.push(cloned);
        }

        const boneInverses = (this.skeleton.boneInverses || []).map(matrix => matrix.clone());
        const skeleton = new THREE.Skeleton(clonedBones, boneInverses);
        const geometry = this.skinnedMesh.geometry.clone();
        const material = Array.isArray(this.skinnedMesh.material)
            ? this.skinnedMesh.material.map(item => item.clone())
            : this.skinnedMesh.material.clone();
        this._configureHorizonFadeMaterial(material);
        const mesh = new THREE.SkinnedMesh(geometry, material);
        mesh.name = `VNCCS Passive Character ${id}`;
        mesh.userData.vnccsPassiveCharacterId = String(id);
        roots.forEach(root => mesh.add(root));
        mesh["bind"](skeleton, this.skinnedMesh.bindMatrix.clone());
        mesh.bindMode = this.skinnedMesh.bindMode;
        this.scene.add(mesh);

        const initialPositions = new Map();
        for (const source of this.boneList) {
            // Clone the currently shaped rest offsets so per-character head,
            const shapedRest = this.shapedBoneRestPositions?.[source.name];
            const initialRest = this.initialBoneStates?.[source.name]?.position;
            initialPositions.set(
                source.name,
                (shapedRest || initialRest || source.position).clone(),
            );
        }
        return {
            id: String(id),
            mesh,
            skeleton,
            boneList: clonedBones,
            bones: Object.fromEntries(clonedBones.map(bone => [bone.name, bone])),
            initialPositions,
            color: this._normalizedCharacterColor(this.activeCharacterAppearance?.color),
        };
    }

    upsertPassiveCharacterFromActive(id, { pose = {}, color, transform } = {}) {
        const key = String(id || "");
        if (!key || !this.isInitialized()) return false;
        this.removePassiveCharacter(key);
        const entry = this._cloneActiveRigForPassiveCharacter(key);
        if (!entry) return false;
        this.passiveCharacters.set(key, entry);
        this._updateHorizonFadeUniforms();
        this.setPassiveCharacterState(key, { pose, color, transform });
        return true;
    }

    setPassiveCharacterState(id, { pose = {}, color, transform } = {}) {
        const entry = this.passiveCharacters?.get(String(id || ""));
        if (!entry) return false;

        for (const bone of entry.boneList) {
            bone.rotation.set(0, 0, 0);
            const initial = entry.initialPositions.get(bone.name);
            if (initial) bone.position.copy(initial);
        }
        for (const [name, rotation] of Object.entries(pose?.bones || {})) {
            const bone = entry.bones[name];
            if (!bone || !Array.isArray(rotation) || rotation.length < 3) continue;
            bone.rotation.set(
                (Number(rotation[0]) || 0) * Math.PI / 180,
                (Number(rotation[1]) || 0) * Math.PI / 180,
                (Number(rotation[2]) || 0) * Math.PI / 180,
            );
        }
        for (const [name, position] of Object.entries(pose?.bonePositions || {})) {
            const bone = entry.bones[name];
            if (!bone || !Array.isArray(position) || position.length < 3) continue;
            const values = position.slice(0, 3).map(Number);
            if (values.every(Number.isFinite)) bone.position.set(values[0], values[1], values[2]);
        }
        for (const [chainKey, position] of Object.entries(pose?.hipBonePosition || {})) {
            const definition = IK_CHAINS[chainKey];
            const bone = definition?.effector ? entry.bones[definition.effector] : null;
            if (bone && Array.isArray(position) && position.length >= 3) {
                bone.position.set(Number(position[0]) || 0, Number(position[1]) || 0, Number(position[2]) || 0);
            }
        }
        const rotation = Array.isArray(pose?.modelRotation) ? pose.modelRotation : [0, 0, 0];
        entry.mesh.rotation.set(
            (Number(rotation[0]) || 0) * Math.PI / 180,
            (Number(rotation[1]) || 0) * Math.PI / 180,
            (Number(rotation[2]) || 0) * Math.PI / 180,
        );
        this._applyCharacterTransform(entry.mesh, transform);
        entry.color = this._normalizedCharacterColor(color ?? entry.color);
        this._applyMaterialCharacterColor(entry.mesh.material, entry.color);
        entry.skeleton.update();
        entry.mesh.updateMatrixWorld(true);
        this.requestRender();
        return true;
    }

    setPassiveCharactersVisible(visible) {
        for (const entry of this.passiveCharacters?.values?.() || []) {
            entry.mesh.visible = visible !== false;
        }
        this.requestRender();
    }


    loadReferenceImage(url) {
        const generation = this._referenceGeneration = (this._referenceGeneration || 0) + 1;
        this._resolveReferenceTexture?.(false);
        this._referenceTextureError = null;
        if (!this.initialized || !this.captureCamera) {
            this.pendingBackgroundUrl = url;
            return;
        }
        const THREE = this.THREE;

        // Create plane if needed
        if (!this.refPlane) {
            const geo = new THREE.PlaneGeometry(1, 1);
            const mat = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 1.0,
                side: THREE.DoubleSide,
                depthWrite: false
            });
            this.refPlane = new THREE.Mesh(geo, mat);
            this.refPlane.visible = false;
            // Render first (background)
            this.refPlane.renderOrder = -1;
            // Attach to camera so it moves with it
            this.captureCamera.add(this.refPlane);

            // Initial positioning (will be fixed in updateCaptureCamera)
            this.refPlane.position.set(0, 0, -50);
            this.refPlane.rotation.set(0, 0, 0);
        }

        // Load texture
        this._referenceTextureReady = false;
        let resolveReady;
        this._referenceTexturePromise = new Promise(resolve => { resolveReady = resolve; });
        this._resolveReferenceTexture = resolveReady;
        new THREE.TextureLoader().load(url, (tex) => {
            if (generation !== this._referenceGeneration || !this.refPlane) {
                tex.dispose();
                resolveReady(false);
                return;
            }
            // Ensure sRGB for real colors
            if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
            else if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;

            if (this.refPlane) {
                this.refPlane.material.map?.dispose();
                this.refPlane.material.map = tex;
                this.refPlane.material.needsUpdate = true;
                this.refPlane.visible = true;
                this.requestRender();
            }
            this._referenceTextureReady = true;
            resolveReady(true);
        }, undefined, () => {
            if (generation === this._referenceGeneration && !this._disposed) {
                this._referenceTextureReady = true;
                this._referenceTextureError = "Failed to load background image. Replace or remove it before capturing.";
            }
            resolveReady(false);
        });
    }

    removeReferenceImage() {
        this._referenceGeneration = (this._referenceGeneration || 0) + 1;
        this._resolveReferenceTexture?.(false);
        this._referenceTexturePromise = null;
        this._referenceTextureReady = true;
        this._referenceTextureError = null;
        this.pendingBackgroundUrl = null;
        if (!this.refPlane) return;
        this.captureCamera.remove(this.refPlane);
        if (this.refPlane.geometry) this.refPlane.geometry.dispose();
        if (this.refPlane.material) {
            if (this.refPlane.material.map) this.refPlane.material.map.dispose();
            this.refPlane.material.dispose();
        }
        this.refPlane = null;
        this.requestRender();
    }

    hasReferenceImage() {
        return this.refPlane !== null && this.refPlane !== undefined;
    }

    updateCaptureCamera(width, height, zoom = 1.0, offsetX = 0, offsetY = 0, yawDeg = 0, pitchDeg = 0, rollDeg = 0) {
        if (!this.THREE || !this.captureCamera) return; // Not initialized yet
        if (this._applySAMProjectionCaptureCamera(width, height, zoom, offsetX, offsetY, yawDeg, pitchDeg, rollDeg)) return;

        const baseTarget = this.sceneCameraTarget || this.meshCenter || new this.THREE.Vector3(0, 10, 0);
        // Apply offset (in world units, scaled by zoom for intuitive control)
        const target = new this.THREE.Vector3(
            baseTarget.x - offsetX,
            baseTarget.y - offsetY,
            baseTarget.z
        );
        const dist = 45;

        // Positioning relative to offset target
        const yawRad = this.THREE.MathUtils.degToRad(Number(yawDeg) || 0);
        const pitchRad = this.THREE.MathUtils.degToRad(Number(pitchDeg) || 0);
        const cameraOffset = new this.THREE.Vector3(0, 0, dist);
        cameraOffset.applyEuler(new this.THREE.Euler(pitchRad, yawRad, 0, 'YXZ'));
        this.captureCamera.aspect = width / height;
        this.captureCamera.fov = POSE_STUDIO_CAPTURE_FOV;
        this.captureCamera.zoom = zoom;
        this.captureCamera.updateProjectionMatrix();
        this.captureCamera.position.copy(target).add(cameraOffset);
        this.captureCamera.up.set(0, 1, 0);
        this.captureCamera.lookAt(target);
        this.captureCamera.rotateZ(this.THREE.MathUtils.degToRad(Number(rollDeg) || 0));

        if (this.refPlane) {
            const planeDist = dist;
            const vFOV = (this.captureCamera.fov * Math.PI) / 180;
            const h = 2 * planeDist * Math.tan(vFOV / 2) / Math.max(0.1, zoom);
            this.refPlane.position.set(0, 0, -planeDist);
            this.refPlane.scale.set(h * this.captureCamera.aspect, h, 1);
            this.refPlane.rotation.set(0, 0, 0);
        }

        if (this.captureFrame) {
            const vFOV = (this.captureCamera.fov * Math.PI) / 180;
            // Frame at target distance (dist = 45)
            const h = 2 * dist * Math.tan(vFOV / 2) / Math.max(0.1, zoom);
            const w = h * this.captureCamera.aspect;
            this.captureFrame.position.copy(target);
            this.captureFrame.scale.set(w / 2, h / 2, 1);
            this.captureFrame.quaternion.copy(this.captureCamera.quaternion);
            this.captureFrame.visible = true;
        }
        if (this.captureFrameGrid && this.captureFrame) {
            this.captureFrameGrid.position.copy(this.captureFrame.position);
            this.captureFrameGrid.scale.copy(this.captureFrame.scale);
            this.captureFrameGrid.quaternion.copy(this.captureFrame.quaternion);
            this.captureFrameGrid.visible = this.captureFrame.visible;
        }
        if (this.captureHorizon && this.captureFrame) {
            this.captureHorizon.position.copy(this.captureFrame.position);
            this.captureHorizon.scale.set(this.captureFrame.scale.x, this.captureFrame.scale.y, this.captureFrame.scale.y);
            this.captureHorizon.quaternion.copy(this.captureFrame.quaternion);
            this.captureHorizon.visible = this.captureFrame.visible;
        }
        if (this.captureHorizonGrid && this.captureFrame) {
            this.captureHorizonGrid.position.copy(this.captureFrame.position);
            this.captureHorizonGrid.scale.set(this.captureFrame.scale.x, this.captureFrame.scale.y, this.captureFrame.scale.y);
            this.captureHorizonGrid.quaternion.copy(this.captureFrame.quaternion);
            this.captureHorizonGrid.visible = this.captureFrame.visible;
        }
        if (this.captureHorizonBoundary && this.captureFrame) {
            this.captureHorizonBoundary.position.copy(this.captureFrame.position);
            this.captureHorizonBoundary.scale.copy(this.captureFrame.scale);
            this.captureHorizonBoundary.quaternion.copy(this.captureFrame.quaternion);
            this.captureHorizonBoundary.visible = this.captureFrame.visible;
        }
        this._updateHorizonFadeUniforms();

        if (this.captureHelper) {
            this.captureHelper.update();
            this.captureHelper.visible = false;
        }
        this.requestRender();
    }

    snapToCaptureCamera(width, height, zoom = 1.0, offsetX = 0, offsetY = 0, yawDeg = 0, pitchDeg = 0, rollDeg = 0) {
        this.updateCaptureCamera(width, height, zoom, offsetX, offsetY, yawDeg, pitchDeg, rollDeg);

        // Disable damping for hard reset
        const prevDamping = this.orbit.enableDamping;
        this.orbit.enableDamping = false;

        // Copy capture camera to viewport camera
        // NOTE: do NOT copy fov/aspect — viewport camera keeps its own frustum
        // so the capture frame appears as a box in 3D space, not filling the whole view.
        // Reset the viewport up vector so returning from top/bottom views keeps the
        // character upright instead of inheriting their alternate roll orientation.
        this.camera.up.set(0, 1, 0).applyQuaternion(this.captureCamera.quaternion);
        this.camera.position.copy(this.captureCamera.position);
        // A small viewport-only zoom makes the reset composition fill the editor canvas better.
        // Capture framing continues to use the requested zoom unchanged.
        if (this.camera.isOrthographicCamera) {
            const distance = this.camera.position.distanceTo(this.captureFrame.position);
            this.camera.top = distance * Math.tan(this.THREE.MathUtils.degToRad(this.camera.fov / 2));
            this.camera.bottom = -this.camera.top;
            this.camera.right = this.camera.top * this.camera.aspect;
            this.camera.left = -this.camera.right;
        }
        this.camera.zoom = zoom * 1.35;
        this.camera.updateProjectionMatrix();

        const target = this._samProjectionCameraFrame
            ? this._getSAMProjectionViewTarget(this.captureCamera)
            : (() => {
                const baseTarget = this.sceneCameraTarget || this.meshCenter || new this.THREE.Vector3(0, 10, 0);
                return new this.THREE.Vector3(
                    baseTarget.x - offsetX,
                    baseTarget.y - offsetY,
                    baseTarget.z
                );
            })();
        this.orbit.target.copy(target);
        this.orbit.update();

        // Shift the reset composition slightly down within the viewport without changing capture framing.
        const distance = this.camera.position.distanceTo(this.orbit.target);
        const visibleHeight = this.viewportVisibleHeight(distance);
        const viewUp = new this.THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
        const verticalNudge = viewUp.multiplyScalar(visibleHeight * 0.035);
        this.camera.position.add(verticalNudge);
        this.orbit.target.add(verticalNudge);
        this.orbit.update();

        this.orbit.enableDamping = prevDamping;
    }

    fitCaptureFrameInViewport(options = {}) {
        if (!this.camera || !this.captureFrame?.visible || !this.captureFrame.geometry) return false;
        const positions = this.captureFrame.geometry.attributes?.position;
        if (!positions?.count) return false;

        const settings = typeof options === 'number' ? { margin: options } : (options || {});
        const safeMargin = Math.max(0.5, Math.min(0.98, Number(settings.margin) || 0.9));
        const insets = settings.insets || {};
        const insetLeft = Math.max(0, Math.min(0.35, Number(insets.left) || 0));
        const insetRight = Math.max(0, Math.min(0.35, Number(insets.right) || 0));
        const insetTop = Math.max(0, Math.min(0.45, Number(insets.top) || 0));
        const insetBottom = Math.max(0, Math.min(0.35, Number(insets.bottom) || 0));
        const safeMinX = -1 + 2 * insetLeft;
        const safeMaxX = 1 - 2 * insetRight;
        const safeMinY = -1 + 2 * insetBottom;
        const safeMaxY = 1 - 2 * insetTop;
        if (safeMaxX <= safeMinX || safeMaxY <= safeMinY) return false;

        this.camera.zoom = 1;
        this.camera.updateProjectionMatrix();
        this.camera.updateMatrixWorld(true);
        this.captureFrame.updateMatrixWorld(true);

        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        const point = new this.THREE.Vector3();
        for (let index = 0; index < positions.count; index += 1) {
            point.fromBufferAttribute(positions, index).applyMatrix4(this.captureFrame.matrixWorld);
            point.project(this.camera);
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.z < -1 || point.z > 1) {
                return false;
            }
            minX = Math.min(minX, point.x);
            maxX = Math.max(maxX, point.x);
            minY = Math.min(minY, point.y);
            maxY = Math.max(maxY, point.y);
        }

        const safeCenterX = (safeMinX + safeMaxX) * 0.5;
        const safeCenterY = (safeMinY + safeMaxY) * 0.5;
        const fitZoom = Math.min(
            (safeMaxX - safeMinX) / Math.max(maxX - minX, 1e-6),
            (safeMaxY - safeMinY) / Math.max(maxY - minY, 1e-6),
        );
        this.camera.zoom = Math.max(0.05, fitZoom * safeMargin);
        this.camera.updateProjectionMatrix();
        const frameCenterX = (minX + maxX) * 0.5 * this.camera.zoom;
        const frameCenterY = (minY + maxY) * 0.5 * this.camera.zoom;
        const distance = Math.max(1e-5, this.camera.position.distanceTo(this.orbit.target));
        const visibleHeight = this.viewportVisibleHeight(distance);
        const visibleWidth = visibleHeight * this.camera.aspect;
        const cameraRight = new this.THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
        const cameraUp = new this.THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
        const cameraShift = cameraRight.multiplyScalar((frameCenterX - safeCenterX) * visibleWidth * 0.5)
            .add(cameraUp.multiplyScalar((frameCenterY - safeCenterY) * visibleHeight * 0.5));
        const previousDamping = this.orbit.enableDamping;
        this.orbit.enableDamping = false;
        this.camera.position.add(cameraShift);
        this.orbit.target.add(cameraShift);
        this.orbit.update();
        this.orbit.enableDamping = previousDamping;
        this.requestRender();
        return true;
    }

    computeModelFitZoom(width = 1024, height = 1024, offsetX = 0, offsetY = 0, yawDeg = 0, pitchDeg = 0, margin = 0.08) {
        if (!this.THREE || !this.skinnedMesh || !this.captureCamera) return null;

        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();

        this.updateCaptureCamera(width, height, 1.0, offsetX, offsetY, yawDeg, pitchDeg);
        this.captureCamera.updateMatrixWorld(true);
        this.captureCamera.updateProjectionMatrix();

        const geometry = this.skinnedMesh.geometry;
        const position = geometry?.attributes?.position;
        if (!position) return null;

        const xs = [];
        const ys = [];
        const point = new this.THREE.Vector3();
        const step = Math.max(1, Math.ceil(position.count / 8000));

        for (let index = 0; index < position.count; index += step) {
            point.fromBufferAttribute(position, index);
            if (typeof this.skinnedMesh.applyBoneTransform === 'function') {
                this.skinnedMesh.applyBoneTransform(index, point);
            }
            point.applyMatrix4(this.skinnedMesh.matrixWorld).project(this.captureCamera);
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) continue;
            xs.push(point.x);
            ys.push(point.y);
        }

        if (xs.length < 16 || ys.length < 16) return null;
        xs.sort((a, b) => a - b);
        ys.sort((a, b) => a - b);
        const pick = (values, q) => values[Math.max(0, Math.min(values.length - 1, Math.floor((values.length - 1) * q)))];
        const minX = pick(xs, 0.01);
        const maxX = pick(xs, 0.99);
        const minY = pick(ys, 0.01);
        const maxY = pick(ys, 0.99);
        const boundsW = Math.max(1e-5, maxX - minX);
        const boundsH = Math.max(1e-5, maxY - minY);
        const target = Math.max(0.2, Math.min(0.98, 1 - Math.max(0, margin) * 2)) * 2;
        return Math.max(0.1, Math.min(7.0, Math.min(target / boundsW, target / boundsH)));
    }

    getCharacterFrameCenter(offsetX = 0, offsetY = 0, offsetZ = 0) {
        const mesh = this.skinnedMesh;
        const camera = this.captureCamera;
        const positions = mesh?.geometry?.attributes?.position;
        if (!this.THREE || !positions || !camera) return null;
        mesh.updateMatrixWorld(true);
        this.skeleton?.update();
        camera.updateMatrixWorld(true);
        const point = new this.THREE.Vector3();
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        // MakeHuman also stores unrendered helper vertices; only drawn triangles define the visible center.
        const indices = mesh.geometry.index;
        const start = Math.max(0, mesh.geometry.drawRange.start);
        const end = Math.min(indices?.count ?? positions.count, start + mesh.geometry.drawRange.count);
        const visited = new Set();
        for (let element = start; element < end; element++) {
            const index = indices ? indices.getX(element) : element;
            if (visited.has(index)) continue;
            visited.add(index);
            point.fromBufferAttribute(positions, index);
            if (typeof mesh.applyBoneTransform === "function") mesh.applyBoneTransform(index, point);
            point.applyMatrix4(mesh.matrixWorld);
            point.x += offsetX;
            point.y += offsetY;
            point.z += offsetZ;
            point.project(camera);
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.z >= 1) continue;
            minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
            minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
        }
        return Number.isFinite(minX) ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2, height: maxY - minY } : null;
    }

    characterTranslationForFramePoint(x, y) {
        // Solve against the projected geometry, including its current age, pose and scale.
        if (!this.THREE || !this.captureCamera || !this.skinnedMesh) return null;
        this.captureCamera.updateMatrixWorld(true);
        const right = new this.THREE.Vector3().setFromMatrixColumn(this.captureCamera.matrixWorld, 0);
        const up = new this.THREE.Vector3().setFromMatrixColumn(this.captureCamera.matrixWorld, 1);
        const measure = (x, y) => this.getCharacterFrameCenter(
            right.x * x + up.x * y, right.y * x + up.y * y, right.z * x + up.z * y,
        );
        let dx = 0, dy = 0;
        const epsilon = 0.01;
        for (let iteration = 0; iteration < 5; iteration++) {
            const center = measure(dx, dy);
            if (!center) return null;
            const ex = x - center.x, ey = y - center.y;
            if (Math.max(Math.abs(ex), Math.abs(ey)) < 1e-9) break;
            const px = measure(dx + epsilon, dy);
            const py = measure(dx, dy + epsilon);
            if (!px || !py) return null;
            const a = (px.x - center.x) / epsilon, b = (py.x - center.x) / epsilon;
            const c = (px.y - center.y) / epsilon, d = (py.y - center.y) / epsilon;
            const determinant = a * d - b * c;
            if (Math.abs(determinant) < 1e-9) return null;
            dx += (ex * d - ey * b) / determinant;
            dy += (ey * a - ex * c) / determinant;
        }
        return {
            x: this.skinnedMesh.position.x + right.x * dx + up.x * dy,
            y: this.skinnedMesh.position.y + right.y * dx + up.y * dy,
            z: this.skinnedMesh.position.z + right.z * dx + up.z * dy,
        };
    }

    computeModelFitFraming(width = 1024, height = 1024, yawDeg = 0, pitchDeg = 0, margin = 0.08) {
        if (!this.THREE || !this.skinnedMesh || !this.captureCamera) return null;

        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();

        const geometry = this.skinnedMesh.geometry;
        const position = geometry?.attributes?.position;
        if (!position) return null;

        const point = new this.THREE.Vector3();
        const step = Math.max(1, Math.ceil(position.count / 8000));
        const projectedBounds = (zoom, offsetX, offsetY) => {
            this.updateCaptureCamera(width, height, zoom, offsetX, offsetY, yawDeg, pitchDeg);
            this.captureCamera.updateMatrixWorld(true);
            this.captureCamera.updateProjectionMatrix();

            const xs = [];
            const ys = [];
            for (let index = 0; index < position.count; index += step) {
                point.fromBufferAttribute(position, index);
                if (typeof this.skinnedMesh.applyBoneTransform === 'function') {
                    this.skinnedMesh.applyBoneTransform(index, point);
                }
                point.applyMatrix4(this.skinnedMesh.matrixWorld).project(this.captureCamera);
                if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) continue;
                xs.push(point.x);
                ys.push(point.y);
            }
            if (xs.length < 16 || ys.length < 16) return null;
            xs.sort((a, b) => a - b);
            ys.sort((a, b) => a - b);
            const pick = (values, q) => values[
                Math.max(0, Math.min(values.length - 1, Math.floor((values.length - 1) * q)))
            ];
            const minX = pick(xs, 0.01);
            const maxX = pick(xs, 0.99);
            const minY = pick(ys, 0.01);
            const maxY = pick(ys, 0.99);
            return {
                minX,
                maxX,
                minY,
                maxY,
                width: Math.max(1e-5, maxX - minX),
                height: Math.max(1e-5, maxY - minY),
                centerX: (minX + maxX) * 0.5,
                centerY: (minY + maxY) * 0.5,
            };
        };

        const baseBounds = projectedBounds(1, 0, 0);
        if (!baseBounds) return null;
        const target = Math.max(0.2, Math.min(0.98, 1 - Math.max(0, margin) * 2)) * 2;
        const zoom = Math.max(
            0.1,
            Math.min(7.0, Math.min(target / baseBounds.width, target / baseBounds.height)),
        );

        const centeredBounds = projectedBounds(zoom, 0, 0);
        if (!centeredBounds) return null;

        // Camera offsets are world-space X/Y translations. With yaw and pitch
        // enabled they are not identical to screen axes, so measure their
        // projected effect and solve the small 2x2 system. This keeps every
        // deformed pose centred instead of reusing the active pose's framing.
        const fov = this.THREE.MathUtils.degToRad(this.captureCamera.fov || 30);
        const visibleHeight = 2 * 45 * Math.tan(fov * 0.5) / zoom;
        const epsilon = Math.max(0.001, visibleHeight * 0.01);
        const xProbe = projectedBounds(zoom, epsilon, 0);
        const yProbe = projectedBounds(zoom, 0, epsilon);
        if (!xProbe || !yProbe) {
            return { zoom, offsetX: 0, offsetY: 0 };
        }

        const j00 = (xProbe.centerX - centeredBounds.centerX) / epsilon;
        const j10 = (xProbe.centerY - centeredBounds.centerY) / epsilon;
        const j01 = (yProbe.centerX - centeredBounds.centerX) / epsilon;
        const j11 = (yProbe.centerY - centeredBounds.centerY) / epsilon;
        const determinant = j00 * j11 - j01 * j10;
        if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) {
            return { zoom, offsetX: 0, offsetY: 0 };
        }

        const offsetX = (
            -centeredBounds.centerX * j11 + centeredBounds.centerY * j01
        ) / determinant;
        const offsetY = (
            -j00 * centeredBounds.centerY + j10 * centeredBounds.centerX
        ) / determinant;
        const maxOffset = visibleHeight * 4;
        return {
            zoom,
            offsetX: Math.max(-maxOffset, Math.min(maxOffset, offsetX)),
            offsetY: Math.max(-maxOffset, Math.min(maxOffset, offsetY)),
        };
    }

    computeSAM3DFrameCameraParams(
        data,
        width = 1024,
        height = 1024,
        meshData = null,
        forceFallback = false,
        standardTargetFrame = null,
    ) {
        if (!this.THREE || !this.skinnedMesh || !this.captureCamera) return null;

        const frame = meshData?.render_frame || null;
        const imageW = Number(frame?.image_size?.width) || Number(data?.image_size?.width) || Number(width) || 1024;
        const imageH = Number(frame?.image_size?.height) || Number(data?.image_size?.height) || Number(height) || 1024;
        if (imageW <= 0 || imageH <= 0) return null;

        const flattenNumbers = (value, out = []) => {
            if (Array.isArray(value)) {
                for (const item of value) flattenNumbers(item, out);
            } else {
                const n = Number(value);
                if (Number.isFinite(n)) out.push(n);
            }
            return out;
        };

        const pointTriplets = (value) => {
            const flat = flattenNumbers(value);
            const points = [];
            for (let i = 0; i + 2 < flat.length; i += 3) {
                points.push([flat[i], flat[i + 1], flat[i + 2]]);
            }
            return points;
        };
        const sourceCamera = flattenNumbers(frame?.camera || data?.camera).slice(0, 3);
        const focalRaw = flattenNumbers(frame?.focal_length ?? data?.focal_length)[0] ?? Number(data?.focal_length);
        const sourceFocal = Number.isFinite(focalRaw) && focalRaw > 0 ? focalRaw : Math.max(imageW, imageH) * 1.2;
        const projectSAMMeshPoint = (point) => {
            if (!Array.isArray(point) || point.length < 3 || sourceCamera.length < 3) return null;
            const x = Number(point[0]) + sourceCamera[0];
            const y = -Number(point[1]) + sourceCamera[1];
            const z = -Number(point[2]) + sourceCamera[2];
            if (![x, y, z].every(Number.isFinite) || z <= 1e-5) return null;
            const px = x * sourceFocal / z + imageW * 0.5;
            const py = y * sourceFocal / z + imageH * 0.5;
            return {
                px,
                py,
                ndcX: (px / imageW - 0.5) * 2,
                ndcY: (0.5 - py / imageH) * 2,
            };
        };
        const sourceFrame = this._samMeshOverlaySourceFrame;
        const samProjectionFrame = (() => {
            if (!sourceFrame?.pelvisWorld || !Array.isArray(sourceFrame?.pelvisSource)) return null;
            if (!sourceCamera || sourceCamera.length < 3) return null;
            const scale = Number(sourceFrame.scale);
            if (!Number.isFinite(scale) || Math.abs(scale) < 1e-8) return null;
            const fov = (2 * Math.atan(imageH / (2 * sourceFocal)) * 180) / Math.PI;
            if (!Number.isFinite(fov) || fov <= 0) return null;
            const ps = sourceFrame.pelvisSource;
            const pw = sourceFrame.pelvisWorld;
            const cam = sourceCamera;
            return {
                fov,
                cameraPosition: {
                    x: pw.x - scale * (Number(ps[0]) + Number(cam[0])),
                    y: pw.y + scale * (Number(cam[1]) - Number(ps[1])),
                    z: pw.z + scale * (Number(cam[2]) - Number(ps[2])),
                },
            };
        })();
        // Compute equivalent yaw/pitch angles for the legacy fallback used by SAM payloads
        // that do not contain a render projection.
        const samCameraAngles = (() => {
            if (!samProjectionFrame) return { yaw_deg: 0, pitch_deg: 0 };
            const tgt = this.meshCenter || new this.THREE.Vector3(0, 10, 0);
            const cp = samProjectionFrame.cameraPosition;
            const dx = (cp.x || 0) - tgt.x;
            const dy = (cp.y || 0) - tgt.y;
            const dz = (cp.z || 0) - tgt.z;
            const yaw = Math.atan2(dx, dz) * 180 / Math.PI;
            const horiz = Math.sqrt(dx * dx + dz * dz);
            const pitch = Math.atan2(-dy, horiz) * 180 / Math.PI;
            return { yaw_deg: yaw, pitch_deg: pitch };
        })();

        const projectSourcePoint = (point) => {
            if (!Array.isArray(point) || point.length < 3 || sourceCamera.length < 3) return null;
            const x = Number(point[0]);
            const y = Number(point[1]);
            const zValue = Number(point[2]) + sourceCamera[2];
            if (![x, y, zValue].every(Number.isFinite) || Math.abs(zValue) < 1e-5) return null;
            const px = (x + sourceCamera[0]) * sourceFocal / zValue + imageW * 0.5;
            const py = (y + sourceCamera[1]) * sourceFocal / zValue + imageH * 0.5;
            return {
                px,
                py,
                ndcX: (px / imageW - 0.5) * 2,
                ndcY: (0.5 - py / imageH) * 2,
            };
        };

        let hasRenderFrameBounds = false;
        const projectedSourceBounds = (() => {
            // Read the exact postprocessed SAM mesh without modifying it.
            if (Array.isArray(meshData?.vertices) && meshData.vertices.length >= 16) {
                let count = 0;
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                for (const vertex of meshData.vertices) {
                    const point = projectSAMMeshPoint(vertex);
                    if (!point) continue;
                    count += 1;
                    minX = Math.min(minX, point.px);
                    minY = Math.min(minY, point.py);
                    maxX = Math.max(maxX, point.px);
                    maxY = Math.max(maxY, point.py);
                }
                if (count >= 16) {
                    hasRenderFrameBounds = true;
                    return {
                        x1: minX,
                        y1: minY,
                        x2: maxX,
                        y2: maxY,
                    };
                }
            }

            const frameBounds = frame?.projected_bounds;
            if (frameBounds) {
                const fx1 = Number(frameBounds.x1);
                const fy1 = Number(frameBounds.y1);
                const fx2 = Number(frameBounds.x2);
                const fy2 = Number(frameBounds.y2);
                if ([fx1, fy1, fx2, fy2].every(Number.isFinite)) {
                    hasRenderFrameBounds = true;
                    return { x1: fx1, y1: fy1, x2: fx2, y2: fy2 };
                }
            }

            const points = [];

            points.push(...pointTriplets(data?.keypoints_3d));

            const bounds = data?.pred_vertices_bounds;
            if (bounds?.center && bounds?.extent) {
                const center = flattenNumbers(bounds.center).slice(0, 3);
                const extent = flattenNumbers(bounds.extent).slice(0, 3);
                if (center.length >= 3 && extent.length >= 3) {
                    for (const sx of [-0.5, 0.5]) {
                        for (const sy of [-0.5, 0.5]) {
                            for (const sz of [-0.5, 0.5]) {
                                points.push([
                                    center[0] + extent[0] * sx,
                                    center[1] + extent[1] * sy,
                                    center[2] + extent[2] * sz,
                                ]);
                            }
                        }
                    }
                }
            }

            if (!sourceCamera || sourceCamera.length < 3 || points.length < 2) return null;
            const xs = [];
            const ys = [];
            for (const point of points) {
                if (!point.every(Number.isFinite)) continue;
                const z = point[2] + sourceCamera[2];
                if (!Number.isFinite(z) || Math.abs(z) < 1e-5) continue;
                xs.push((point[0] + sourceCamera[0]) * sourceFocal / z + imageW * 0.5);
                ys.push((point[1] + sourceCamera[1]) * sourceFocal / z + imageH * 0.5);
            }
            if (xs.length < 2 || ys.length < 2) return null;
            xs.sort((a, b) => a - b);
            ys.sort((a, b) => a - b);
            return {
                x1: xs[0],
                y1: ys[0],
                x2: xs[xs.length - 1],
                y2: ys[ys.length - 1],
            };
        })();
        let x1;
        let y1;
        let x2;
        let y2;
        const sourceBoxValue = data?.source_bbox || data?.bbox;
        const sourceBox = Array.isArray(sourceBoxValue?.[0]) ? sourceBoxValue[0] : sourceBoxValue;
        const hasSourceBox = Array.isArray(sourceBox)
            && sourceBox.length >= 4
            && sourceBox.slice(0, 4).every(value => Number.isFinite(Number(value)));
        // Multi-person imports must keep each person's original image-space
        // location. The fitted SAM mesh is centered around its own camera and
        // its projected bounds therefore cannot represent that source offset.
        if (!hasSourceBox && projectedSourceBounds) {
            const projectedW = Math.abs(projectedSourceBounds.x2 - projectedSourceBounds.x1);
            const projectedH = Math.abs(projectedSourceBounds.y2 - projectedSourceBounds.y1);
            if (projectedW > 1 && projectedH > 1) {
                x1 = projectedSourceBounds.x1;
                y1 = projectedSourceBounds.y1;
                x2 = projectedSourceBounds.x2;
                y2 = projectedSourceBounds.y2;
            }
        }
        if (![x1, y1, x2, y2].every(Number.isFinite)) {
            const rawBox = sourceBox;
            if (!Array.isArray(rawBox) || rawBox.length < 4) return null;
            x1 = Number(rawBox[0]);
            y1 = Number(rawBox[1]);
            x2 = Number(rawBox[2]);
            y2 = Number(rawBox[3]);
        }
        if (![x1, y1, x2, y2].every(Number.isFinite)) return null;

        const bboxW = Math.max(1, Math.abs(x2 - x1));
        const bboxH = Math.max(1, Math.abs(y2 - y1));
        const desiredW = Math.min(12.0, Math.max(0.08, bboxW / imageW));
        const desiredH = Math.min(12.0, Math.max(0.08, bboxH / imageH));
        const desiredCenterX = ((x1 + x2) * 0.5 / imageW - 0.5) * 2;
        const desiredCenterY = (0.5 - (y1 + y2) * 0.5 / imageH) * 2;
        const sourceShoulderFrame = (() => {
            if (typeof this._buildSAM3DNamedPoints !== 'function') return null;
            const named = this._buildSAM3DNamedPoints(data);
            const fittedCoordinates = Array.isArray(data?.joint_coords);
            const projectShoulder = (side) => {
                if (fittedCoordinates) {
                    const fitted = named[`${side}_shoulder`];
                    const projected = projectSAMMeshPoint(fitted);
                    if (projected) return projected;
                }
                return projectSourcePoint(
                    named[`raw_${side}_shoulder`] || named[`canonical_${side}_shoulder`],
                );
            };
            const projected = [projectShoulder('left'), projectShoulder('right')].filter(Boolean);
            if (!projected.length) return null;
            const py = projected.reduce((sum, point) => sum + point.py, 0) / projected.length;
            const ndcY = projected.reduce((sum, point) => sum + point.ndcY, 0) / projected.length;
            const shoulderToBottomNdc = ((Math.max(y1, y2) - py) / imageH) * 2;
            if (!Number.isFinite(py) || !Number.isFinite(ndcY) || !Number.isFinite(shoulderToBottomNdc)) return null;
            if (py < Math.min(y1, y2) - imageH || py > Math.max(y1, y2) + imageH) return null;
            if (shoulderToBottomNdc < 0.15 || shoulderToBottomNdc > 8.0) return null;
            return {
                py,
                ndcY,
                shoulderToBottomNdc,
            };
        })();

        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();

        const projectedBounds = (camera) => {
            if (!camera) return null;
            camera.updateMatrixWorld(true);
            camera.updateProjectionMatrix();

            const xs = [];
            const ys = [];
            const depths = [];

            const collectMesh = (mesh) => {
                const geometry = mesh?.geometry;
                const position = geometry?.attributes?.position;
                if (!mesh || !position) return;

                mesh.updateMatrixWorld(true);
                const point = new this.THREE.Vector3();
                const cameraPoint = new this.THREE.Vector3();
                for (let index = 0; index < position.count; index++) {
                    point.fromBufferAttribute(position, index);
                    if (typeof mesh.applyBoneTransform === 'function') {
                        mesh.applyBoneTransform(index, point);
                    }
                    point.applyMatrix4(mesh.matrixWorld);
                    cameraPoint.copy(point).applyMatrix4(camera.matrixWorldInverse);
                    if (!Number.isFinite(cameraPoint.z) || cameraPoint.z >= -1e-5) continue;
                    depths.push(-cameraPoint.z);
                    point.project(camera);
                    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) continue;
                    xs.push(point.x);
                    ys.push(point.y);
                }
            };

            // Capture/export contains the mannequin, not the debug SAM overlay.
            // Always frame the geometry that will actually be rendered.
            if (this.skinnedMesh) collectMesh(this.skinnedMesh);

            if (xs.length < 16 || ys.length < 16 || depths.length < 16) return null;
            xs.sort((a, b) => a - b);
            ys.sort((a, b) => a - b);
            depths.sort((a, b) => a - b);
            const pick = (values, q) => values[Math.max(0, Math.min(values.length - 1, Math.floor((values.length - 1) * q)))];
            const min = new this.THREE.Vector2(xs[0], ys[0]);
            const max = new this.THREE.Vector2(xs[xs.length - 1], ys[ys.length - 1]);
            if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) return null;
            return {
                min,
                max,
                width: Math.max(1e-5, max.x - min.x),
                height: Math.max(1e-5, max.y - min.y),
                centerX: (min.x + max.x) * 0.5,
                centerY: (min.y + max.y) * 0.5,
                depth: pick(depths, 0.5),
            };
        };
        const projectedBoneCenterY = (camera, boneNames) => {
            camera.updateMatrixWorld(true);
            camera.updateProjectionMatrix();
            const values = [];
            for (const boneName of boneNames) {
                const bone = this.bones?.[boneName];
                if (!bone) continue;
                const point = new this.THREE.Vector3();
                bone.getWorldPosition(point);
                point.project(camera);
                if (Number.isFinite(point.y)) values.push(point.y);
            }
            if (!values.length) return null;
            return values.reduce((sum, value) => sum + value, 0) / values.length;
        };

        // Preserve SAM's camera direction, then match the complete mannequin to
        // the source person's exact head-to-sole interval. Horizontal body width
        // must not reduce character height.
        if (samProjectionFrame && !forceFallback) {
            const projectionCamera = new this.THREE.PerspectiveCamera(
                samProjectionFrame.fov,
                (Number(width) || 1024) / Math.max(1, Number(height) || 1024),
                this.captureCamera.near,
                this.captureCamera.far,
            );
            projectionCamera.zoom = 1.0;
            projectionCamera.up.set(0, 1, 0);
            projectionCamera.position.set(
                Number(samProjectionFrame.cameraPosition.x) || 0,
                Number(samProjectionFrame.cameraPosition.y) || 0,
                Number(samProjectionFrame.cameraPosition.z) || 0,
            );
            projectionCamera.lookAt(new this.THREE.Vector3(
                projectionCamera.position.x,
                projectionCamera.position.y,
                projectionCamera.position.z - 1,
            ));
            projectionCamera.updateMatrixWorld(true);
            projectionCamera.updateProjectionMatrix();

            const modelBounds = projectedBounds(projectionCamera);
            const modelShoulderY = projectedBoneCenterY(
                projectionCamera,
                ['upperarm_l', 'upperarm_r'],
            );
            const visibleModelFrame = clipSAMProjectionFrameToViewport(
                modelBounds,
                modelShoulderY,
            );
            // Keep the source crop in diagnostics, but match the ordinary
            // camera to the visible SAM-rendered mannequin. The recovered SAM
            // camera follows the character world transform, so this projected
            // frame is stable across saved zoom/pan values. Using the source
            // body bounds here made the ordinary mannequin visibly smaller
            // whenever its head/limb extents differed from the SAM body mesh.
            const visibleSourceFrame = clipSAMProjectionFrameToViewport({
                width: desiredW * 2,
                height: desiredH * 2,
                centerX: desiredCenterX,
                centerY: desiredCenterY,
                depth: 1,
            }, sourceShoulderFrame?.ndcY) || visibleModelFrame;
            const fit = computeSAMProjectionFrameFit({
                modelBounds,
                desiredBounds: {
                    width: desiredW * 2,
                    height: desiredH * 2,
                    centerX: desiredCenterX,
                    centerY: desiredCenterY,
                },
                fov: projectionCamera.fov,
                aspect: projectionCamera.aspect,
                modelShoulderY,
                desiredShoulderY: sourceShoulderFrame?.ndcY,
                desiredBottomY: desiredCenterY - desiredH,
            });
            return {
                zoom: fit?.zoom ?? 0.96,
                offset_x: fit?.offset_x ?? 0,
                offset_y: fit?.offset_y ?? 0,
                yaw_deg: 0,
                pitch_deg: 0,
                sam_projection: samProjectionFrame,
                // Standard-camera matching must reproduce the crop visible in
                // the source viewport. Geometry outside the image is not a
                // reason to zoom out and reveal the complete body.
                sam_standard_target: visibleModelFrame,
                sam_fit_debug: {
                    mode: 'sam_projection',
                    image_size: { width: imageW, height: imageH },
                    camera: {
                        fov: projectionCamera.fov,
                        position: {
                            x: projectionCamera.position.x,
                            y: projectionCamera.position.y,
                            z: projectionCamera.position.z,
                        },
                    },
                    source_frame_pixels: { x1, y1, x2, y2 },
                    visible_source_frame: visibleSourceFrame,
                    projected_model_bounds: modelBounds ? {
                        min_x: modelBounds.min.x,
                        min_y: modelBounds.min.y,
                        max_x: modelBounds.max.x,
                        max_y: modelBounds.max.y,
                        width: modelBounds.width,
                        height: modelBounds.height,
                        center_x: modelBounds.centerX,
                        center_y: modelBounds.centerY,
                    } : null,
                    visible_model_frame: visibleModelFrame,
                    shoulder_y: Number.isFinite(modelShoulderY) ? modelShoulderY : null,
                    discarded_projection_fit: fit,
                },
            };
        }

        const baseTarget = this.meshCenter || new this.THREE.Vector3(0, 10, 0);
        const dist = 45;
        const aspect = (Number(width) || 1024) / Math.max(1, Number(height) || 1024);
        const vFOV = (this.captureCamera.fov * Math.PI) / 180;
        const visibleHAtZoom1 = 2 * dist * Math.tan(vFOV / 2);
        const visibleWAtZoom1 = visibleHAtZoom1 * aspect;

        this.updateCaptureCamera(width, height, 1.0, 0, 0);
        const baseBounds = projectedBounds(this.captureCamera);
        if (baseBounds) {
            if (forceFallback) {
                const modelShoulderY = projectedBoneCenterY(
                    this.captureCamera,
                    ['upperarm_l', 'upperarm_r'],
                );
                const visibleBaseFrame = clipSAMProjectionFrameToViewport(
                    baseBounds,
                    modelShoulderY,
                );
                const targetBounds = standardTargetFrame?.bounds;
                const targetValues = [
                    targetBounds?.width,
                    targetBounds?.height,
                    targetBounds?.centerX,
                    targetBounds?.centerY,
                ].map(Number);
                const hasProjectionTarget = targetValues.every(Number.isFinite)
                    && targetValues[0] > 1e-5
                    && targetValues[1] > 1e-5;
                const desiredBounds = hasProjectionTarget ? {
                    width: targetValues[0],
                    height: targetValues[1],
                    centerX: targetValues[2],
                    centerY: targetValues[3],
                } : {
                    width: desiredW * 2,
                    height: desiredH * 2,
                    centerX: desiredCenterX,
                    centerY: desiredCenterY,
                };
                const fit = computeSAMProjectionFrameFit({
                    modelBounds: visibleBaseFrame?.bounds || baseBounds,
                    desiredBounds,
                    fov: this.captureCamera.fov,
                    aspect: this.captureCamera.aspect,
                    // When matching the same mannequin between SAM and the
                    // ordinary camera, its complete visible bbox is the scale
                    // contract. Shoulder anchoring intentionally ignores the
                    // head/top extent and was the remaining under-zoom cause.
                    modelShoulderY: hasProjectionTarget
                        ? null
                        : visibleBaseFrame?.shoulder_y ?? modelShoulderY,
                    desiredShoulderY: hasProjectionTarget
                        ? null
                        : sourceShoulderFrame?.ndcY,
                    desiredBottomY: hasProjectionTarget
                        ? null
                        : desiredCenterY - desiredH,
                });
                if (fit) {
                    this.updateCaptureCamera(width, height, fit.zoom, fit.offset_x, fit.offset_y);
                    return {
                        ...fit,
                        ...samCameraAngles,
                        sam_fit_debug: {
                            mode: 'standard_camera',
                            image_size: { width: imageW, height: imageH },
                            camera: {
                                fov: this.captureCamera.fov,
                                aspect: this.captureCamera.aspect,
                            },
                            used_projection_target: hasProjectionTarget,
                            alignment_mode: hasProjectionTarget
                                ? 'visible_model_bounds'
                                : 'source_shoulder_to_bottom',
                            requested_target_frame: standardTargetFrame,
                            desired_bounds: desiredBounds,
                            raw_model_bounds: {
                                min_x: baseBounds.min.x,
                                min_y: baseBounds.min.y,
                                max_x: baseBounds.max.x,
                                max_y: baseBounds.max.y,
                                width: baseBounds.width,
                                height: baseBounds.height,
                                center_x: baseBounds.centerX,
                                center_y: baseBounds.centerY,
                            },
                            visible_model_frame: visibleBaseFrame,
                            model_shoulder_y: Number.isFinite(modelShoulderY) ? modelShoulderY : null,
                            result: { ...fit },
                        },
                    };
                }
            }

            const desiredNdcW = desiredW * 2;
            const desiredNdcH = desiredH * 2;
            const zoomForW = desiredNdcW / baseBounds.width;
            const baseShoulderY = projectedBoneCenterY(this.captureCamera, ['upperarm_l', 'upperarm_r']);
            const baseShoulderToBottom = Number.isFinite(baseShoulderY) ? Math.max(1e-5, baseShoulderY - baseBounds.min.y) : null;
            const zoomForH = (sourceShoulderFrame && baseShoulderToBottom)
                ? sourceShoulderFrame.shoulderToBottomNdc / baseShoulderToBottom
                : desiredNdcH / baseBounds.height;
            const zoom = Math.min(16, Math.max(0.1, Math.min(zoomForW, zoomForH) * 0.98));

            this.updateCaptureCamera(width, height, zoom, 0, 0);
            const zoomedBounds = projectedBounds(this.captureCamera) || baseBounds;
            const zoomedShoulderY = projectedBoneCenterY(this.captureCamera, ['upperarm_l', 'upperarm_r']);
            const visibleW = visibleWAtZoom1 / zoom;
            const visibleH = visibleHAtZoom1 / zoom;
            let offset_x = -(zoomedBounds.centerX - desiredCenterX) * visibleW * 0.5;
            let offset_y = (sourceShoulderFrame && Number.isFinite(zoomedShoulderY))
                ? -(zoomedShoulderY - sourceShoulderFrame.ndcY) * visibleH * 0.5
                : -(zoomedBounds.centerY - desiredCenterY) * visibleH * 0.5;
            offset_x = Math.max(-visibleW * 4, Math.min(visibleW * 4, offset_x));
            offset_y = Math.max(-visibleH * 4, Math.min(visibleH * 4, offset_y));

            this.updateCaptureCamera(width, height, zoom, offset_x, offset_y);
            return { zoom, offset_x, offset_y, ...samCameraAngles };
        }

        const box = new this.THREE.Box3().setFromObject(this.skinnedMesh);
        if (box.isEmpty()) return null;

        const size = new this.THREE.Vector3();
        const center = new this.THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        if (size.x <= 1e-5 || size.y <= 1e-5) return null;

        const zoomForH = desiredH * visibleHAtZoom1 / size.y;
        const zoomForW = desiredW * visibleWAtZoom1 / size.x;
        const zoom = Math.min(16, Math.max(0.1, Math.min(zoomForH, zoomForW) * 0.96));

        const visibleH = visibleHAtZoom1 / zoom;
        const visibleW = visibleWAtZoom1 / zoom;
        const targetX = center.x - desiredCenterX * visibleW * 0.5;
        const targetY = center.y - desiredCenterY * visibleH * 0.5;
        return {
            zoom,
            offset_x: baseTarget.x - targetX,
            offset_y: baseTarget.y - targetY,
            ...samCameraAngles,
        };
    }

    fitSAM3DToStandardCamera(
        data,
        width = 1024,
        height = 1024,
        meshData = null,
        standardTargetFrame = null,
    ) {
        const angleParams = this.computeSAM3DFrameCameraParams(
            data,
            width,
            height,
            meshData,
            true,
            standardTargetFrame,
        );
        if (!angleParams) return null;

        const yaw = Number(angleParams.yaw_deg) || 0;
        const pitch = Number(angleParams.pitch_deg) || 0;
        if (Math.abs(yaw) > 0.5 || Math.abs(pitch) > 0.5) {
            const currentRotation = this.getPose?.()?.modelRotation || [0, 0, 0];
            this.setModelRotation(
                (Number(currentRotation[0]) || 0) - pitch,
                (Number(currentRotation[1]) || 0) - yaw,
                Number(currentRotation[2]) || 0,
            );
        }

        // Rotation changes the projected head/sole positions, especially for
        // high- and low-angle images. Measure again only after it is applied.
        return this.computeSAM3DFrameCameraParams(
            data,
            width,
            height,
            meshData,
            true,
            standardTargetFrame,
        );
    }

    beginCaptureBatch(width, height) {
        if (!this.initialized || !this.renderer || !this.THREE) return false;
        const targetWidth = Math.max(1, Math.round(Number(width) || 1));
        const targetHeight = Math.max(1, Math.round(Number(height) || 1));
        if (this._captureBatch) {
            if (this._captureBatch.width !== targetWidth || this._captureBatch.height !== targetHeight) {
                this.renderer.setSize(targetWidth, targetHeight, false);
                this._captureBatch.width = targetWidth;
                this._captureBatch.height = targetHeight;
            }
            return false;
        }

        const originalSize = new this.THREE.Vector2();
        this.renderer.getSize(originalSize);
        this._captureBatch = {
            width: targetWidth,
            height: targetHeight,
            originalWidth: originalSize.x,
            originalHeight: originalSize.y,
            originalPixelRatio: this.renderer.getPixelRatio(),
        };
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(targetWidth, targetHeight, false);
        return true;
    }

    endCaptureBatch() {
        const batch = this._captureBatch;
        if (!batch || !this.renderer) return;
        this._captureBatch = null;
        this.renderer.setPixelRatio(batch.originalPixelRatio);
        this.renderer.setSize(batch.originalWidth, batch.originalHeight, false);
        if (this.initialized && this.scene && this.camera) {
            // Restoring the drawing-buffer size clears it just like a viewport
            // resize. Repaint synchronously to avoid a visible flash after capture.
            this.renderer.render(this.scene, this.camera);
            this._needsRender = false;
        }
    }

    renderInteractionOverlay() {
        if (!this.initialized || !this.renderer) return;
        const hidden = [this.skinnedMesh, this.gridHelper, this.captureFrame, this.captureFrameGrid, this.captureHorizon, this.captureHorizonGrid, this.captureHorizonBoundary, this.refPlane,
            ...Array.from(this.passiveCharacters?.values?.() || [], entry => entry.mesh)];
        const visibility = hidden.map(item => item?.visible);
        const background = this.scene.background;
        try {
            hidden.forEach(item => { if (item) item.visible = false; });
            this.scene.background = null;
            this.renderer.render(this.scene, this.camera);
        } finally {
            hidden.forEach((item, index) => { if (item) item.visible = visibility[index]; });
            this.scene.background = background;
        }
    }

    _getCaptureRenderCamera() {
        if (!this.camera.isOrthographicCamera) return this.captureCamera;
        // Match the parallel editor's placement relative to the capture frame,
        // including characters in front of or behind the frame plane.
        const halfWidth = this.captureFrame.scale.x;
        const halfHeight = this.captureFrame.scale.y;
        const camera = new this.THREE.OrthographicCamera(
            -halfWidth, halfWidth, halfHeight, -halfHeight,
            this.captureCamera.near, this.captureCamera.far,
        );
        camera.position.copy(this.captureCamera.position);
        camera.quaternion.copy(this.captureCamera.quaternion);
        camera.updateMatrixWorld(true);
        return camera;
    }

    capture(width, height, zoom, bgColor, offsetX = 0, offsetY = 0, yawDeg = 0, pitchDeg = 0, options = {}) {
        if (!this.initialized) return null;

        this._capturingOriginalCharacterColors = true;
        this.refreshCharacterSelectionColors();
        // Ensure camera is setup
        this.updateCaptureCamera(width, height, zoom, offsetX, offsetY, yawDeg, pitchDeg, options.roll_deg ?? this.cameraParams?.roll_deg ?? 0);

        // Hide UI elements
        const markerVisibility = this.jointMarkers.map(marker => marker.visible);
        const transformVisible = this.transform ? this.transform.visible : true;
        const helperVisibility = [this.skeletonHelper, this.gridHelper, this.captureFrame, this.captureFrameGrid, this.captureHorizon, this.captureHorizonGrid, this.captureHorizonBoundary, this.refPlane].map(item => item?.visible);

        // Hide Helpers
        const importedFigureVisibility = {
            kp: this._kpFigureGroup?.visible,
            rtmw: this._rtmwFigureGroup?.visible,
            hmr2: this._hmr2FigureGroup?.visible,
            hmr2Canvas: this._hmr2CanvasGroup?.visible,
            samMesh: this._samMeshOverlayGroup?.visible,
        };
        const handRingVisibility = Array.isArray(this._handRings)
            ? this._handRings.map((ring) => ring?.visible ?? false)
            : null;
        if (this.transform) this.transform.visible = false;
        if (this.skeletonHelper) this.skeletonHelper.visible = false;
        if (this.gridHelper) this.gridHelper.visible = false;
        if (this.captureFrame) this.captureFrame.visible = false;
        if (this.captureFrameGrid) this.captureFrameGrid.visible = false;
        if (this.captureHorizon) this.captureHorizon.visible = false;
        if (this.captureHorizonGrid) this.captureHorizonGrid.visible = false;
        if (this.captureHorizonBoundary) this.captureHorizonBoundary.visible = false;
        if (this._kpFigureGroup) this._kpFigureGroup.visible = false;
        if (this._rtmwFigureGroup) this._rtmwFigureGroup.visible = false;
        if (this._hmr2FigureGroup) this._hmr2FigureGroup.visible = false;
        if (this._hmr2CanvasGroup) this._hmr2CanvasGroup.visible = false;
        if (this._samMeshOverlayGroup) this._samMeshOverlayGroup.visible = false;
        if (Array.isArray(this._handRings)) {
            this._handRings.forEach((ring) => {
                if (ring) ring.visible = false;
            });
        }
        this.jointMarkers.forEach(m => m.visible = false);
        // Hide IK effectors and pole targets
        const effectorVisibility = {};
        const poleVisibility = {};
        if (this.ikController) {
            for (const [name, effector] of Object.entries(this.ikController.effectors)) {
                effectorVisibility[name] = effector.visible;
                effector.visible = false;
            }
            for (const [key, pole] of Object.entries(this.ikController.poleTargets)) {
                poleVisibility[key] = pole.visible;
                pole.visible = false;
            }
        }

        // Background Override
        const oldBg = this.scene.background;
        if (options.transparent) this.scene.background = null;
        if (options.hideReference && this.refPlane) this.refPlane.visible = false;
        if (!options.transparent && bgColor && Array.isArray(bgColor) && bgColor.length === 3) {
            this.scene.background = new this.THREE.Color(
                bgColor[0] / 255, bgColor[1] / 255, bgColor[2] / 255
            );
        }

        let dataURL = null;
        const ownsCaptureBatch = !this._captureBatch;
        this._setHorizonFadeEnabled(false);

        try {
            this.beginCaptureBatch(width, height);
            // Render with Fixed Camera
            this.renderer.render(this.scene, this._getCaptureRenderCamera());
            if (options.targetCanvas) {
                const target = options.targetCanvas;
                if (target.width !== width) target.width = width;
                if (target.height !== height) target.height = height;
                const ctx = target.getContext("2d");
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(this.canvas, 0, 0, width, height);
                dataURL = target;
            } else {
                dataURL = this.canvas.toDataURL("image/png");
            }
        } catch (e) {
            console.error("Capture failed:", e);
        } finally {
            // Restore state
            this._capturingOriginalCharacterColors = false;
            this.refreshCharacterSelectionColors();
            this._setHorizonFadeEnabled(true);
            this.scene.background = oldBg;

            this.jointMarkers.forEach((marker, index) => {
                marker.visible = markerVisibility[index] && this._shouldMarkerBeVisible(marker);
            });
            if (this.transform) this.transform.visible = transformVisible;
            [this.skeletonHelper, this.gridHelper, this.captureFrame, this.captureFrameGrid, this.captureHorizon, this.captureHorizonGrid, this.captureHorizonBoundary, this.refPlane].forEach((item, index) => {
                if (item) item.visible = helperVisibility[index];
            });
            if (this._kpFigureGroup) this._kpFigureGroup.visible = importedFigureVisibility.kp ?? this.importedFigureVisible;
            if (this._rtmwFigureGroup) this._rtmwFigureGroup.visible = importedFigureVisibility.rtmw ?? this.importedFigureVisible;
            if (this._hmr2FigureGroup) this._hmr2FigureGroup.visible = importedFigureVisibility.hmr2 ?? this.importedFigureVisible;
            if (this._hmr2CanvasGroup) this._hmr2CanvasGroup.visible = importedFigureVisibility.hmr2Canvas ?? this.importedFigureVisible;
            if (this._samMeshOverlayGroup) this._samMeshOverlayGroup.visible = importedFigureVisibility.samMesh ?? this.samMeshOverlayVisible;
            if (Array.isArray(this._handRings)) {
                this._handRings.forEach((ring, index) => {
                    if (ring) ring.visible = handRingVisibility?.[index] ?? true;
                });
            }

            // Restore IK effectors and pole targets visibility
            if (this.ikController) {
                for (const [name, effector] of Object.entries(this.ikController.effectors)) {
                    effector.visible = effectorVisibility[name] ?? false;
                }
                for (const [key, pole] of Object.entries(this.ikController.poleTargets)) {
                    pole.visible = poleVisibility[key] ?? false;
                }
            }
            if (ownsCaptureBatch) this.endCaptureBatch();
        }
        return dataURL;
    }

    _clearImportedFigureGroup(groupName) {
        const group = this[groupName];
        if (!group) return;
        group.traverse((object) => {
            if (object.geometry) object.geometry.dispose();
            if (object.material) {
                if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
                else object.material.dispose();
            }
        });
        if (group.parent) group.parent.remove(group);
        this[groupName] = null;
    }

    clearSAMMeshOverlay() {
        this._clearImportedFigureGroup('_samMeshOverlayGroup');
        this._samMeshOverlayWorldKps = null;
        this._samMeshOverlaySourceFrame = null;
        this._samProjectionCameraFrame = null;
        this.requestRender();
    }

    clearSAMProjectionCameraFrame() {
        this._samProjectionCameraFrame = null;
        this.requestRender();
    }

    setSAMMeshOverlayVisible(visible) {
        this.samMeshOverlayVisible = !!visible;
        if (this._samMeshOverlayGroup) {
            this._samMeshOverlayGroup.visible = this.samMeshOverlayVisible;
            this.requestRender();
        }
    }

    setSAMProjectionCameraFrame(frame) {
        this._samProjectionCameraFrame = frame || null;
    }

    _getSAMProjectionViewTarget(camera = this.captureCamera) {
        const center = this.meshCenter || new this.THREE.Vector3(0, 10, 0);
        if (!camera || !this.THREE) return center.clone();
        const forward = new this.THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
        const toCenter = center.clone().sub(camera.position);
        let depth = toCenter.dot(forward);
        if (!Number.isFinite(depth) || depth < 1e-5) {
            depth = Math.max(1.0, camera.position.distanceTo(center));
        }
        return camera.position.clone().addScaledVector(forward, depth);
    }

    _applySAMProjectionCaptureCamera(width, height, zoom = 1.0, offsetX = 0, offsetY = 0, yawDeg = 0, pitchDeg = 0, rollDeg = 0) {
        const frame = this._samProjectionCameraFrame;
        if (!frame || !this.THREE || !this.captureCamera) return false;
        const cameraPosition = frame.cameraPosition;
        const fov = Number(frame.fov);
        const projectionZoom = Number(frame.projection_zoom ?? 1);
        if (
            !cameraPosition
            || !Number.isFinite(fov)
            || fov <= 0
            || !Number.isFinite(projectionZoom)
            || projectionZoom <= 0
        ) return false;

        this.captureCamera.aspect = (Number(width) || 1024) / Math.max(1, Number(height) || 1024);
        this.captureCamera.fov = fov;
        this.captureCamera.zoom = (Number(zoom) || 1.0) * projectionZoom;
        this.captureCamera.up.set(0, 1, 0);
        this.captureCamera.position.set(
            Number(cameraPosition.x) || 0,
            Number(cameraPosition.y) || 0,
            Number(cameraPosition.z) || 0
        );
        const pan = new this.THREE.Vector3();
        const right = new this.THREE.Vector3(1, 0, 0);
        const up = new this.THREE.Vector3(0, 1, 0);
        pan.addScaledVector(right, -Number(offsetX || 0));
        pan.addScaledVector(up, -Number(offsetY || 0));
        this.captureCamera.position.add(pan);
        const target = new this.THREE.Vector3(
            this.captureCamera.position.x,
            this.captureCamera.position.y,
            this.captureCamera.position.z - 1
        );
        this.captureCamera.lookAt(target);
        const yaw = Number(yawDeg) || 0;
        const pitch = Number(pitchDeg) || 0;
        if (Math.abs(yaw) > 1e-6 || Math.abs(pitch) > 1e-6) {
            const orbitTarget = this._getSAMProjectionViewTarget(this.captureCamera);
            const offset = this.captureCamera.position.clone().sub(orbitTarget);
            offset.applyEuler(new this.THREE.Euler(
                this.THREE.MathUtils.degToRad(pitch),
                this.THREE.MathUtils.degToRad(yaw),
                0,
                'YXZ'
            ));
            this.captureCamera.position.copy(orbitTarget).add(offset);
            this.captureCamera.lookAt(orbitTarget);
        }
        this.captureCamera.rotateZ(this.THREE.MathUtils.degToRad(Number(rollDeg) || 0));
        this.captureCamera.updateProjectionMatrix();

        const frameTarget = this._getSAMProjectionViewTarget(this.captureCamera);
        if (this.refPlane) {
            const planeDist = Math.max(1e-5, this.captureCamera.position.distanceTo(frameTarget));
            const vFOV = (this.captureCamera.fov * Math.PI) / 180;
            const h = 2 * planeDist * Math.tan(vFOV / 2) / this.captureCamera.zoom;
            const w = h * this.captureCamera.aspect;
            this.refPlane.position.set(0, 0, -planeDist);
            this.refPlane.scale.set(w, h, 1);
            this.refPlane.rotation.set(0, 0, 0);
        }
        if (this.captureFrame) {
            const frameCenter = frameTarget.clone();
            const planeDist = Math.max(1e-5, this.captureCamera.position.distanceTo(frameCenter));
            const vFOV = (this.captureCamera.fov * Math.PI) / 180;
            const h = 2 * planeDist * Math.tan(vFOV / 2) / this.captureCamera.zoom;
            const w = h * this.captureCamera.aspect;
            this.captureFrame.position.copy(frameCenter);
            this.captureFrame.scale.set(w / 2, h / 2, 1);
            this.captureFrame.quaternion.copy(this.captureCamera.quaternion);
            this.captureFrame.visible = true;
        }
        if (this.captureFrameGrid && this.captureFrame) {
            this.captureFrameGrid.position.copy(this.captureFrame.position);
            this.captureFrameGrid.scale.copy(this.captureFrame.scale);
            this.captureFrameGrid.quaternion.copy(this.captureFrame.quaternion);
            this.captureFrameGrid.visible = this.captureFrame.visible;
        }
        if (this.captureHorizon && this.captureFrame) {
            this.captureHorizon.position.copy(this.captureFrame.position);
            this.captureHorizon.scale.set(this.captureFrame.scale.x, this.captureFrame.scale.y, this.captureFrame.scale.y);
            this.captureHorizon.quaternion.copy(this.captureFrame.quaternion);
            this.captureHorizon.visible = this.captureFrame.visible;
        }
        if (this.captureHorizonGrid && this.captureFrame) {
            this.captureHorizonGrid.position.copy(this.captureFrame.position);
            this.captureHorizonGrid.scale.set(this.captureFrame.scale.x, this.captureFrame.scale.y, this.captureFrame.scale.y);
            this.captureHorizonGrid.quaternion.copy(this.captureFrame.quaternion);
            this.captureHorizonGrid.visible = this.captureFrame.visible;
        }
        if (this.captureHorizonBoundary && this.captureFrame) {
            this.captureHorizonBoundary.position.copy(this.captureFrame.position);
            this.captureHorizonBoundary.scale.copy(this.captureFrame.scale);
            this.captureHorizonBoundary.quaternion.copy(this.captureFrame.quaternion);
            this.captureHorizonBoundary.visible = this.captureFrame.visible;
        }
        this._updateHorizonFadeUniforms();
        if (this.captureHelper) {
            this.captureHelper.update();
            this.captureHelper.visible = false;
        }
        this.requestRender();
        return true;
    }

    setSAMMeshOverlayData(meshData, poseData) {
        if (!this.THREE || !this.scene || !meshData || !Array.isArray(meshData.vertices)) return false;

        this.clearSAMMeshOverlay();

        const overlayPose = (Array.isArray(meshData.fitted_joint_coords) && poseData)
            ? { ...poseData, joint_coords: meshData.fitted_joint_coords }
            : (poseData || {});
        const named = this._buildSAM3DNamedPoints(overlayPose);
        const leftHip = named.left_hip || named.thigh_l;
        const rightHip = named.right_hip || named.thigh_r;
        const pelvisSource = (leftHip && rightHip)
            ? [
                (leftHip[0] + rightHip[0]) * 0.5,
                (leftHip[1] + rightHip[1]) * 0.5,
                (leftHip[2] + rightHip[2]) * 0.5,
            ]
            : (named.pelvis || null);
        const neckSource = named.neck || named.neck_01 || null;
        const pelvisWorld = this._getBoneWorldPositionForImport('pelvis') || this._getBoneWorldPositionForImport('spine_01');
        const neckWorld = this._getBoneWorldPositionForImport('neck_01') || this._getBoneWorldPositionForImport('head');
        if (!pelvisSource || !pelvisWorld) return false;

        let scale = 1.0;
        if (neckSource && neckWorld) {
            const sourceLen = Math.hypot(
                neckSource[0] - pelvisSource[0],
                neckSource[1] - pelvisSource[1],
                neckSource[2] - pelvisSource[2],
            );
            const worldLen = neckWorld.distanceTo(pelvisWorld);
            if (sourceLen > 1e-5 && worldLen > 1e-5) scale = worldLen / sourceLen;
        }

        const sourceToWorldPoint = (point) => {
            if (!Array.isArray(point) || point.length < 3) return null;
            return new this.THREE.Vector3(
                pelvisWorld.x + (Number(point[0]) - pelvisSource[0]) * scale,
                pelvisWorld.y + (Number(point[1]) - pelvisSource[1]) * scale,
                pelvisWorld.z + (Number(point[2]) - pelvisSource[2]) * scale,
            );
        };
        this._samMeshOverlaySourceFrame = {
            pelvisSource: [...pelvisSource],
            pelvisWorld: pelvisWorld.clone(),
            scale,
            renderFrame: meshData.render_frame || null,
        };

        const vertices = meshData.vertices;
        const positions = new Float32Array(vertices.length * 3);
        for (let i = 0; i < vertices.length; i++) {
            const point = sourceToWorldPoint(vertices[i]);
            if (!point) continue;
            positions[i * 3] = point.x;
            positions[i * 3 + 1] = point.y;
            positions[i * 3 + 2] = point.z;
        }

        const geometry = new this.THREE.BufferGeometry();
        geometry.setAttribute('position', new this.THREE.BufferAttribute(positions, 3));
        const faces = Array.isArray(meshData.faces) ? meshData.faces : [];
        const indices = [];
        for (const face of faces) {
            if (!Array.isArray(face) || face.length < 3) continue;
            indices.push(Number(face[0]), Number(face[1]), Number(face[2]));
        }
        if (indices.length) geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const material = new this.THREE.MeshPhongMaterial({
            color: 0xd8ccb0,
            transparent: true,
            opacity: 0.34,
            depthWrite: false,
            side: this.THREE.DoubleSide,
        });
        const mesh = new this.THREE.Mesh(geometry, material);
        mesh.name = 'sam3d_render_mesh_overlay';
        mesh.renderOrder = 40;

        const group = new this.THREE.Group();
        group.name = 'sam3d_render_mesh_overlay_group';
        group.add(mesh);
        group.visible = this.samMeshOverlayVisible;
        this.scene.add(group);
        this._samMeshOverlayGroup = group;

        const fittedWorldKps = this._buildSAM3DOverlayWorldKps(meshData, overlayPose, sourceToWorldPoint);
        if (fittedWorldKps) {
            this._samMeshOverlayWorldKps = fittedWorldKps;
            this._hmr2WorldKps = fittedWorldKps;
            this._drawHMR2Figure(fittedWorldKps);
        }

        this.requestRender();
        return true;
    }

    _buildSAM3DOverlayWorldKps(meshData, poseData, sourceToWorldPoint) {
        if (!meshData || !poseData || typeof sourceToWorldPoint !== 'function') return null;
        const jointCoords = Array.isArray(meshData.fitted_joint_coords)
            ? meshData.fitted_joint_coords
            : (Array.isArray(meshData.joint_coords) ? meshData.joint_coords : null);
        if (!jointCoords) return null;

        const overlayPose = {
            ...poseData,
            joint_coords: jointCoords,
        };
        const named = this._buildSAM3DNamedPoints(overlayPose);
        const pointNames = new Set([
            'pelvis', 'neck', 'neck_01', 'neck_tail', 'head',
            'spine_01', 'spine_02', 'spine_03',
            'clavicle_l', 'clavicle_r',
            'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r',
            'thigh_l', 'thigh_r', 'calf_l', 'calf_r', 'foot_l', 'foot_r',
            'canonical_nose', 'canonical_left_eye', 'canonical_right_eye',
            'canonical_left_ear', 'canonical_right_ear',
            'left_shoulder', 'right_shoulder',
            'left_elbow', 'right_elbow',
            'left_wrist', 'right_wrist',
            'left_hip', 'right_hip',
            'left_knee', 'right_knee',
            'left_ankle', 'right_ankle',
            'left_big_toe', 'left_small_toe', 'left_heel',
            'right_big_toe', 'right_small_toe', 'right_heel',
        ]);
        for (const name of SAM3D_FINGER_POINT_NAMES) pointNames.add(name);

        const worldKps = {};
        for (const name of pointNames) {
            const point = named[name];
            const worldPoint = sourceToWorldPoint(point);
            if (worldPoint) worldKps[name] = worldPoint;
        }

        if (!worldKps.neck && named.neck_01) {
            const point = sourceToWorldPoint(named.neck_01);
            if (point) worldKps.neck = point;
        }
        if (!worldKps.neck_tail && named.head) {
            const point = sourceToWorldPoint(named.head);
            if (point) worldKps.neck_tail = point;
        }
        return Object.keys(worldKps).length ? worldKps : null;
    }

    _buildSAM3DImportTargetsFromWorldKps(worldKps) {
        if (!worldKps) return null;
        return {
            worldKps,
            effectorTargets: {
                pelvis: worldKps.pelvis || null,
                head: worldKps.head || worldKps.neck_tail || null,
                hand_l: worldKps.left_wrist || null,
                hand_r: worldKps.right_wrist || null,
                foot_l: worldKps.left_ankle || null,
                foot_r: worldKps.right_ankle || null,
                upperarm_l: worldKps.left_shoulder || null,
                upperarm_r: worldKps.right_shoulder || null,
            },
            poleTargets: {
                leftArm: worldKps.left_elbow || null,
                rightArm: worldKps.right_elbow || null,
                leftLeg: worldKps.left_knee || null,
                rightLeg: worldKps.right_knee || null,
            },
        };
    }

    /**
     * Apply already-normalized world-space body landmarks through the same
     * alignment stages used by the current image-pose importer. This is also
     * the canonical entry point for skeletal sources such as Mixamo FBX.
     */
    applyWorldKeypointImport(worldKps, options = {}) {
        if (!worldKps?.pelvis || !this.bones || !this.skinnedMesh || !this.ikController) return false;

        const importTargets = this._buildSAM3DImportTargetsFromWorldKps(worldKps);
        if (!importTargets) return false;

        if (options.drawFigure !== false) {
            this._hmr2WorldKps = worldKps;
            this._drawHMR2Figure(worldKps);
        }
        this._applyImportPelvisAndTorso(worldKps, options.shoulderYOffset || 0);
        if (options.placeHipRoots !== false) {
            this._placeSAM3DHipRoots(importTargets.worldKps || worldKps);
        }
        this._applySAM3DTargetIK(importTargets, {
            includeSpine: options.includeSpine !== false,
            normalizeLimbs: options.normalizeLimbs !== false,
            normalizeArms: options.normalizeArms !== false,
            normalizeLegs: options.normalizeLegs !== false,
            drawNormalizedFigure: options.drawFigure !== false,
        });

        const alignedWorldKps = importTargets.worldKps || worldKps;
        if (options.alignHead !== false) this._applySAM3DHeadLineRetarget(alignedWorldKps);
        if (options.alignHands !== false) this._applySAM3DHandPointRetarget(alignedWorldKps);
        if (options.alignFeet !== false) {
            this._applySAM3DFootPointRetarget(alignedWorldKps, options.footLocalRotations || null);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateIKEffectorPositions?.();
        if (options.updateMarkers !== false) this.updateMarkers();
        this.requestRender();
        if (options.dispatchPoseChange !== false) this.dispatchPoseChange();
        return true;
    }

    _placeSAM3DHipRoots(worldKps) {
        if (!this.THREE || !this.skinnedMesh || !this.bones || !worldKps) return false;
        this.skinnedMesh.updateMatrixWorld(true);
        let applied = false;
        for (const side of ['l', 'r']) {
            const thigh = this.bones[`thigh_${side}`];
            const target = worldKps[side === 'l' ? 'left_hip' : 'right_hip'];
            if (!thigh?.parent || !target) continue;

            // Move the complete leg from its socket. This removes pelvis-width
            // error before IK without changing thigh/shin lengths or translating
            // the ankle independently from the rest of the leg.
            thigh.parent.updateMatrixWorld(true);
            thigh.position.copy(thigh.parent.worldToLocal(target.clone()));
            thigh.updateMatrixWorld(true);
            applied = true;
        }
        if (applied) this.skinnedMesh.updateMatrixWorld(true);
        return applied;
    }

    fitCurrentPoseToSAMMeshOverlay(shoulderYOffset = 0, options = {}) {
        const worldKps = this._samMeshOverlayWorldKps;
        const passCount = 6;
        for (let pass = 0; pass < passCount; pass++) {
            this.fitSAM3DJointRootLengthsToWorldKps(worldKps);
            this.fitSAM3DLimbLengthsToWorldKps(worldKps);
            const finalPass = pass === passCount - 1;
            const applied = this.applyWorldKeypointImport(worldKps, {
                shoulderYOffset,
                // Solve the torso/head once. Later passes only converge limb-root
                // proportions and IK, so the allowed smaller head cannot drift.
                includeSpine: pass === 0,
                normalizeLimbs: false,
                footLocalRotations: this._sam3dImportedFootLocalRotations || null,
                drawFigure: finalPass,
                updateMarkers: finalPass,
                dispatchPoseChange: finalPass && options.dispatchPoseChange !== false,
            });
            if (!applied) return false;
        }
        return true;
    }

    fitSAM3DJointRootLengthsToWorldKps(worldKps) {
        if (!worldKps || !this.bones || !this.skinnedMesh) return null;
        this.skinnedMesh.updateMatrixWorld(true);

        const fitted = {};
        const fitRoot = (group, parentName, childName, target) => {
            const parent = this._getBoneWorldPositionForImport(parentName);
            const child = this._getBoneWorldPositionForImport(childName);
            if (!parent || !child || !target) return;
            const currentLength = parent.distanceTo(child);
            const currentScale = this._lengthSliderToScale(this.boneLengthParams?.[group] ?? 0.5);
            const baseLength = currentScale > 1e-5 ? currentLength / currentScale : 0;
            const targetLength = parent.distanceTo(target);
            if (baseLength <= 1e-5 || targetLength <= 1e-5) return;
            fitted[group] = Math.max(0, Math.min(1, targetLength / baseLength - 0.5));
        };

        fitRoot('shoulder_l', 'clavicle_l', 'upperarm_l', worldKps.left_shoulder);
        fitRoot('shoulder_r', 'clavicle_r', 'upperarm_r', worldKps.right_shoulder);
        fitRoot('hip_l', 'pelvis', 'thigh_l', worldKps.left_hip);
        fitRoot('hip_r', 'pelvis', 'thigh_r', worldKps.right_hip);
        for (const [group, value] of Object.entries(fitted)) {
            this.updateBoneLengthScale(group, value);
        }
        return Object.keys(fitted).length ? fitted : null;
    }

    fitSAM3DLimbLengthsToWorldKps(worldKps) {
        if (!worldKps || !this.bones || !this.skinnedMesh) return null;

        this.skinnedMesh.updateMatrixWorld(true);

        const measuredBaseLength = (rootBoneName, endBoneName, group) => {
            const root = this._getBoneWorldPositionForImport(rootBoneName);
            const end = this._getBoneWorldPositionForImport(endBoneName);
            const currentLength = root && end ? root.distanceTo(end) : 0;
            const currentSlider = Number(this.boneLengthParams?.[group]);
            const currentScale = this._lengthSliderToScale(
                Number.isFinite(currentSlider) ? currentSlider : 0.5,
            );
            if (currentLength <= 1e-5 || currentScale <= 1e-5) return 0;
            return currentLength / currentScale;
        };
        const sliderValue = (targetLength, baseWorldLength) => {
            if (targetLength <= 1e-5 || baseWorldLength <= 1e-5) return null;
            const targetScale = targetLength / baseWorldLength;
            return Math.max(0, Math.min(1, targetScale - 0.5));
        };

        const fitted = {};
        const fitSide = (side) => {
            const prefix = side === 'l' ? 'left' : 'right';
            const shoulder = worldKps[`${prefix}_shoulder`];
            const elbow = worldKps[`${prefix}_elbow`];
            const wrist = worldKps[`${prefix}_wrist`];
            if (!shoulder || !elbow || !wrist) return;

            const targetUpper = shoulder.distanceTo(elbow);
            const targetLower = elbow.distanceTo(wrist);
            const upperGroup = `upper_arm_${side}`;
            const lowerGroup = `forearm_${side}`;
            const baseUpper = measuredBaseLength(`upperarm_${side}`, `lowerarm_${side}`, upperGroup);
            const baseLower = measuredBaseLength(`lowerarm_${side}`, `hand_${side}`, lowerGroup);
            const upperValue = sliderValue(targetUpper, baseUpper);
            const lowerValue = sliderValue(targetLower, baseLower);
            if (upperValue !== null) fitted[upperGroup] = upperValue;
            if (lowerValue !== null) fitted[lowerGroup] = lowerValue;
        };

        fitSide('l');
        fitSide('r');

        const fitLeg = (side) => {
            const prefix = side === 'l' ? 'left' : 'right';
            const hip = worldKps[`${prefix}_hip`];
            const knee = worldKps[`${prefix}_knee`];
            const ankle = worldKps[`${prefix}_ankle`];
            if (!hip || !knee || !ankle) return;

            const thighGroup = `thigh_${side}`;
            const shinGroup = `shin_${side}`;
            const baseThigh = measuredBaseLength(`thigh_${side}`, `calf_${side}`, thighGroup);
            const baseShin = measuredBaseLength(`calf_${side}`, `foot_${side}`, shinGroup);
            const thighValue = sliderValue(hip.distanceTo(knee), baseThigh);
            const shinValue = sliderValue(knee.distanceTo(ankle), baseShin);
            if (thighValue !== null) fitted[thighGroup] = thighValue;
            if (shinValue !== null) fitted[shinGroup] = shinValue;
        };

        fitLeg('l');
        fitLeg('r');
        for (const [group, value] of Object.entries(fitted)) {
            this.updateBoneLengthScale(group, value);
        }
        return Object.keys(fitted).length ? fitted : null;
    }

    fitSAM3DArmLengthsToWorldKps(worldKps) {
        return this.fitSAM3DLimbLengthsToWorldKps(worldKps);
    }

    _estimateCurrentModelHeight() {
        if (!this.skinnedMesh || !this.THREE) return 1.7;
        const bounds = new this.THREE.Box3().setFromObject(this.skinnedMesh);
        const size = new this.THREE.Vector3();
        bounds.getSize(size);
        return size.y > 0.5 ? size.y : 1.7;
    }

    _drawHMR2Figure(worldKps) {
        if (!this.scene || !this.THREE || !worldKps) return;

        this._clearImportedFigureGroup('_hmr2FigureGroup');
        this._clearImportedFigureGroup('_rtmwFigureGroup');
        this._clearImportedFigureGroup('_kpFigureGroup');

        const bones = [
            ['canonical_nose', 'canonical_left_eye', 0xff66ff],
            ['canonical_nose', 'canonical_right_eye', 0xff66ff],
            ['canonical_left_eye', 'canonical_right_eye', 0xff66ff],
            ['canonical_left_eye', 'canonical_left_ear', 0xff66ff],
            ['canonical_right_eye', 'canonical_right_ear', 0xff66ff],
            ['neck', 'neck_tail', 0x00ffff],
            ['neck', 'right_shoulder', 0xff7700],
            ['neck', 'left_shoulder', 0x00aa00],
            ['neck', 'pelvis', 0xffff00],
            ['pelvis', 'right_hip', 0xff7700],
            ['pelvis', 'left_hip', 0x00aa00],
            ['right_shoulder', 'right_elbow', 0xff7700],
            ['right_elbow', 'right_wrist', 0xffaa00],
            ['left_shoulder', 'left_elbow', 0x00aa00],
            ['left_elbow', 'left_wrist', 0x00dd00],
            ['right_hip', 'right_knee', 0xff00ff],
            ['right_knee', 'right_ankle', 0xaa00ff],
            ['right_ankle', 'right_big_toe', 0xaa66ff],
            ['right_ankle', 'right_small_toe', 0xaa66ff],
            ['right_ankle', 'right_heel', 0xaa66ff],
            ['right_big_toe', 'right_small_toe', 0xaa66ff],
            ['left_hip', 'left_knee', 0x00ffff],
            ['left_knee', 'left_ankle', 0x0088ff],
            ['left_ankle', 'left_big_toe', 0x66ccff],
            ['left_ankle', 'left_small_toe', 0x66ccff],
            ['left_ankle', 'left_heel', 0x66ccff],
            ['left_big_toe', 'left_small_toe', 0x66ccff],
            ['left_wrist', 'thumb_01_l', 0x00ccff],
            ['thumb_01_l', 'thumb_02_l', 0x00ccff],
            ['thumb_02_l', 'thumb_03_l', 0x00ccff],
            ['left_wrist', 'index_01_l', 0x00ccff],
            ['index_01_l', 'index_02_l', 0x00ccff],
            ['index_02_l', 'index_03_l', 0x00ccff],
            ['left_wrist', 'middle_01_l', 0x00ccff],
            ['middle_01_l', 'middle_02_l', 0x00ccff],
            ['middle_02_l', 'middle_03_l', 0x00ccff],
            ['left_wrist', 'ring_01_l', 0x00ccff],
            ['ring_01_l', 'ring_02_l', 0x00ccff],
            ['ring_02_l', 'ring_03_l', 0x00ccff],
            ['left_wrist', 'pinky_01_l', 0x00ccff],
            ['pinky_01_l', 'pinky_02_l', 0x00ccff],
            ['pinky_02_l', 'pinky_03_l', 0x00ccff],
            ['right_wrist', 'thumb_01_r', 0x5599ff],
            ['thumb_01_r', 'thumb_02_r', 0x5599ff],
            ['thumb_02_r', 'thumb_03_r', 0x5599ff],
            ['right_wrist', 'index_01_r', 0x5599ff],
            ['index_01_r', 'index_02_r', 0x5599ff],
            ['index_02_r', 'index_03_r', 0x5599ff],
            ['right_wrist', 'middle_01_r', 0x5599ff],
            ['middle_01_r', 'middle_02_r', 0x5599ff],
            ['middle_02_r', 'middle_03_r', 0x5599ff],
            ['right_wrist', 'ring_01_r', 0x5599ff],
            ['ring_01_r', 'ring_02_r', 0x5599ff],
            ['ring_02_r', 'ring_03_r', 0x5599ff],
            ['right_wrist', 'pinky_01_r', 0x5599ff],
            ['pinky_01_r', 'pinky_02_r', 0x5599ff],
            ['pinky_02_r', 'pinky_03_r', 0x5599ff],
        ];

        const group = new this.THREE.Group();
        group.name = 'hmr2v1_figure';

        const jointGeo = new this.THREE.SphereGeometry(0.025, 8, 8);
        const jointMat = new this.THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });

        for (const [name, point] of Object.entries(worldKps)) {
            if (!point) continue;
            const material = jointMat.clone();
            if (name === 'head' || name === 'neck') {
                material.color.setHex(0x00ffff);
            } else if (name.startsWith('canonical_')) {
                material.color.setHex(0xff66ff);
            }
            const mesh = new this.THREE.Mesh(jointGeo, material);
            mesh.position.copy(point);
            mesh.renderOrder = 999;
            group.add(mesh);
        }

        for (const [fromName, toName, color] of bones) {
            const from = worldKps[fromName];
            const to = worldKps[toName];
            if (!from || !to) continue;
            const geometry = new this.THREE.BufferGeometry().setFromPoints([from, to]);
            const material = new this.THREE.LineBasicMaterial({ color, depthTest: false });
            const line = new this.THREE.Line(geometry, material);
            line.renderOrder = 998;
            group.add(line);
        }

        this.scene.add(group);
        group.visible = this.importedFigureVisible !== false;
        this._hmr2FigureGroup = group;
    }

    _buildSAM3DNamedPoints(data) {
        const namedPoints = {};

        const keypointSources = [
            { prefix: 'canonical', points: data?.canonical_keypoints_3d },
            { prefix: 'raw', points: data?.keypoints_3d },
        ];
        for (const { prefix, points } of keypointSources) {
            if (!Array.isArray(points)) continue;
            for (let index = 0; index < Math.min(points.length, SAM3D_KEYPOINT_NAMES.length); index++) {
                const point = points[index];
                const name = SAM3D_KEYPOINT_NAMES[index];
                if (!Array.isArray(point) || point.length < 3 || !name) continue;
                if (prefix === 'canonical') namedPoints[name] = point;
                namedPoints[`${prefix}_${name}`] = point;
            }
        }

        if (Array.isArray(data?.joint_coords)) {
            for (let index = 0; index < data.joint_coords.length; index++) {
                const point = data.joint_coords[index];
                if (!Array.isArray(point) || point.length < 3) continue;
                const genericName = `joint_${String(index).padStart(3, '0')}`;
                const namedJoint = this._getSAM3DJointName(data, index);
                namedPoints[genericName] = point;
                if (namedJoint && !namedPoints[namedJoint]) namedPoints[namedJoint] = point;
            }
            for (const [indexString, name] of Object.entries(SAM3D_JOINT_COORD_NAMES)) {
                const index = Number(indexString);
                const point = data.joint_coords[index];
                if (!Array.isArray(point) || point.length < 3) continue;
                namedPoints[name] = point;
            }
        }

        // SAM3DBody Render/Export uses dense MHR joint_coords, not the 70
        // image keypoints. Mirror those coordinates onto the generic names
        // consumed by the debug skeleton so we never mix two different pose
        // spaces in one figure.
        const mhrAliases = {
            neck: 'neck_01',
            left_shoulder: 'upperarm_l',
            right_shoulder: 'upperarm_r',
            left_elbow: 'lowerarm_l',
            right_elbow: 'lowerarm_r',
            left_wrist: 'hand_l',
            right_wrist: 'hand_r',
            left_hip: 'thigh_l',
            right_hip: 'thigh_r',
            left_knee: 'calf_l',
            right_knee: 'calf_r',
            left_ankle: 'foot_l',
            right_ankle: 'foot_r',
        };
        for (const [alias, sourceName] of Object.entries(mhrAliases)) {
            if (namedPoints[sourceName]) namedPoints[alias] = namedPoints[sourceName];
        }

        const fingerAliases = {
            left_thumb: ['thumb_01_l', 'thumb_02_l', 'thumb_03_l'],
            left_index: ['index_01_l', 'index_02_l', 'index_03_l'],
            left_middle: ['middle_01_l', 'middle_02_l', 'middle_03_l'],
            left_ring: ['ring_01_l', 'ring_02_l', 'ring_03_l'],
            left_pinky: ['pinky_01_l', 'pinky_02_l', 'pinky_03_l'],
            right_thumb: ['thumb_01_r', 'thumb_02_r', 'thumb_03_r'],
            right_index: ['index_01_r', 'index_02_r', 'index_03_r'],
            right_middle: ['middle_01_r', 'middle_02_r', 'middle_03_r'],
            right_ring: ['ring_01_r', 'ring_02_r', 'ring_03_r'],
            right_pinky: ['pinky_01_r', 'pinky_02_r', 'pinky_03_r'],
        };
        for (const [prefix, names] of Object.entries(fingerAliases)) {
            for (let index = 0; index < names.length; index++) {
                if (namedPoints[names[index]]) namedPoints[`${prefix}_${index + 1}`] = namedPoints[names[index]];
            }
        }

        return namedPoints;
    }

    _getSAM3DPointByIndex(points, index) {
        if (!Array.isArray(points) || index < 0 || index >= points.length) return null;
        const point = points[index];
        return Array.isArray(point) && point.length >= 3 ? point : null;
    }

    _pickSAM3DChainChildIndex(data, jointIndex) {
        const parents = Array.isArray(data?.joint_parents) ? data.joint_parents : null;
        if (!parents) return null;

        const children = [];
        for (let index = 0; index < parents.length; index++) {
            if (Number(parents[index]) === jointIndex) children.push(index);
        }
        if (!children.length) return null;
        if (children.length === 1) return children[0];

        const rest = Array.isArray(data?.rest_joint_coords) ? data.rest_joint_coords : data?.joint_coords;
        const parentIndex = Number(parents[jointIndex]);
        const jointPoint = this._getSAM3DPointByIndex(rest, jointIndex);
        const parentPoint = this._getSAM3DPointByIndex(rest, parentIndex);
        if (!jointPoint || !parentPoint) return children[0];

        const axis = [
            jointPoint[0] - parentPoint[0],
            jointPoint[1] - parentPoint[1],
            jointPoint[2] - parentPoint[2],
        ];
        const axisLen = Math.hypot(axis[0], axis[1], axis[2]);
        if (axisLen <= 1e-6) return children[0];
        axis[0] /= axisLen;
        axis[1] /= axisLen;
        axis[2] /= axisLen;

        let best = children[0];
        let bestScore = -Infinity;
        for (const childIndex of children) {
            const childPoint = this._getSAM3DPointByIndex(rest, childIndex);
            if (!childPoint) continue;
            const direction = [
                childPoint[0] - jointPoint[0],
                childPoint[1] - jointPoint[1],
                childPoint[2] - jointPoint[2],
            ];
            const length = Math.hypot(direction[0], direction[1], direction[2]);
            if (length <= 1e-6) continue;
            const score = (
                direction[0] / length * axis[0]
                + direction[1] / length * axis[1]
                + direction[2] / length * axis[2]
            );
            if (score > bestScore) {
                bestScore = score;
                best = childIndex;
            }
        }
        return best;
    }

    _pickSAM3DChainChildPoint(data, namedPoints, jointIndex) {
        const childIndex = this._pickSAM3DChainChildIndex(data, jointIndex);
        if (childIndex == null) return null;
        const genericName = `joint_${String(childIndex).padStart(3, '0')}`;
        const namedJoint = this._getSAM3DJointName(data, childIndex);
        return namedPoints[genericName] || namedPoints[namedJoint] || this._getSAM3DPointByIndex(data?.joint_coords, childIndex);
    }

    _averageSAM3DPoint(namedPoints, names) {
        const valid = names
            .map((name) => namedPoints[name])
            .filter((point) => Array.isArray(point) && point.length >= 3);
        if (!valid.length) return null;
        const sum = [0, 0, 0];
        for (const point of valid) {
            sum[0] += point[0];
            sum[1] += point[1];
            sum[2] += point[2];
        }
        return sum.map((value) => value / valid.length);
    }

    _getBoneWorldPositionForImport(boneName) {
        if (!this.THREE || !this.bones?.[boneName]) return null;
        const position = new this.THREE.Vector3();
        this.bones[boneName].getWorldPosition(position);
        return position;
    }

    _getBoneWorldQuaternionForImport(boneName) {
        if (!this.THREE || !this.bones?.[boneName]) return null;
        const quaternion = new this.THREE.Quaternion();
        this.bones[boneName].getWorldQuaternion(quaternion);
        return quaternion;
    }

    _captureBoneLocalRotations(boneNames) {
        if (!this.bones || !Array.isArray(boneNames)) return {};
        const rotations = {};
        for (const boneName of boneNames) {
            const bone = this.bones[boneName];
            if (bone) rotations[boneName] = bone.quaternion.clone();
        }
        return rotations;
    }

    _restoreBoneLocalRotations(rotations) {
        if (!this.bones || !rotations) return;
        for (const [boneName, quaternion] of Object.entries(rotations)) {
            const bone = this.bones[boneName];
            if (!bone || !quaternion) continue;
            bone.quaternion.copy(quaternion);
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            bone.updateMatrixWorld(true);
        }
    }

    _captureBoneWorldRotations(boneNames) {
        if (!this.THREE || !this.bones || !Array.isArray(boneNames)) return {};
        const rotations = {};
        for (const boneName of boneNames) {
            const quaternion = this._getBoneWorldQuaternionForImport(boneName);
            if (quaternion) rotations[boneName] = quaternion;
        }
        return rotations;
    }

    _restoreBoneWorldRotations(rotations, order = null) {
        if (!this.THREE || !this.bones || !rotations) return;
        const boneNames = Array.isArray(order) ? order : Object.keys(rotations);
        for (const boneName of boneNames) {
            const bone = this.bones[boneName];
            const worldQuaternion = rotations[boneName];
            if (!bone || !worldQuaternion) continue;
            const parentWorld = new this.THREE.Quaternion();
            if (bone.parent) bone.parent.getWorldQuaternion(parentWorld);
            bone.quaternion.copy(parentWorld.invert().multiply(worldQuaternion.clone()).normalize());
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            bone.updateMatrixWorld(true);
        }
    }

    _alignBoneWorldDirection(boneName, targetDirection) {
        const bone = this.bones?.[boneName];
        if (!this.THREE || !bone || !targetDirection || targetDirection.lengthSq() < 1e-8) return false;

        const child = bone.children?.find((item) => item?.isBone) || null;
        if (!child) return false;

        const bonePosition = new this.THREE.Vector3();
        const childPosition = new this.THREE.Vector3();
        bone.getWorldPosition(bonePosition);
        child.getWorldPosition(childPosition);

        const currentDirection = childPosition.sub(bonePosition);
        if (currentDirection.lengthSq() < 1e-8) return false;
        currentDirection.normalize();

        const target = targetDirection.clone().normalize();
        const delta = new this.THREE.Quaternion().setFromUnitVectors(currentDirection, target);
        const boneWorld = new this.THREE.Quaternion();
        bone.getWorldQuaternion(boneWorld);

        const parentWorld = new this.THREE.Quaternion();
        if (bone.parent) bone.parent.getWorldQuaternion(parentWorld);
        bone.quaternion.copy(parentWorld.invert().multiply(delta.multiply(boneWorld)).normalize());
        bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
        bone.updateMatrixWorld(true);
        return true;
    }

    _alignHandWorldBasis(side, worldKps) {
        if (!this.THREE || !worldKps) return false;

        const hand = this.bones?.[`hand_${side}`];
        const index = this.bones?.[`index_01_${side}`];
        const middle = this.bones?.[`middle_01_${side}`];
        const ring = this.bones?.[`ring_01_${side}`];
        if (!hand || !index || !middle || !ring) return false;

        const targetIndex = worldKps[`index_01_${side}`];
        const targetMiddle = worldKps[`middle_01_${side}`];
        const targetRing = worldKps[`ring_01_${side}`];
        const targetWrist = worldKps[side === 'l' ? 'left_wrist' : 'right_wrist'];
        if (!targetIndex || !targetMiddle || !targetRing || !targetWrist) return false;

        const getBonePosition = (bone) => {
            const position = new this.THREE.Vector3();
            bone.getWorldPosition(position);
            return position;
        };
        const handPos = getBonePosition(hand);
        const currentIndex = getBonePosition(index);
        const currentMiddle = getBonePosition(middle);
        const currentRing = getBonePosition(ring);

        const makeBasis = (wrist, indexPoint, middlePoint, ringPoint) => {
            const forward = middlePoint.clone().sub(wrist);
            const across = indexPoint.clone().sub(ringPoint);
            if (forward.lengthSq() < 1e-8 || across.lengthSq() < 1e-8) return null;
            forward.normalize();
            across.sub(forward.clone().multiplyScalar(across.dot(forward)));
            if (across.lengthSq() < 1e-8) return null;
            across.normalize();
            const normal = new this.THREE.Vector3().crossVectors(across, forward).normalize();
            if (normal.lengthSq() < 1e-8) return null;
            return new this.THREE.Matrix4().makeBasis(across, forward, normal);
        };

        const currentBasis = makeBasis(handPos, currentIndex, currentMiddle, currentRing);
        const targetBasis = makeBasis(targetWrist, targetIndex, targetMiddle, targetRing);
        if (!currentBasis || !targetBasis) return false;

        const deltaMatrix = targetBasis.clone().multiply(currentBasis.clone().transpose());
        const delta = new this.THREE.Quaternion().setFromRotationMatrix(deltaMatrix).normalize();
        const handWorld = new this.THREE.Quaternion();
        hand.getWorldQuaternion(handWorld);

        const parentWorld = new this.THREE.Quaternion();
        if (hand.parent) hand.parent.getWorldQuaternion(parentWorld);
        hand.quaternion.copy(parentWorld.invert().multiply(delta.multiply(handWorld)).normalize());
        hand.rotation.setFromQuaternion(hand.quaternion, hand.rotation.order);
        hand.updateMatrixWorld(true);
        return true;
    }

    _applySAM3DHandPointRetarget(worldKps) {
        if (!this.THREE || !this.bones || !this.skinnedMesh || !worldKps) return;

        const applySide = (side) => {
            this._alignHandWorldBasis(side, worldKps);
            this.skinnedMesh.updateMatrixWorld(true);

            for (const prefix of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
                const p1 = worldKps[`${prefix}_01_${side}`];
                const p2 = worldKps[`${prefix}_02_${side}`];
                const p3 = worldKps[`${prefix}_03_${side}`];

                if (p1 && p2) {
                    this._alignBoneWorldDirection(`${prefix}_01_${side}`, p2.clone().sub(p1));
                    this.skinnedMesh.updateMatrixWorld(true);
                }
                if (p2 && p3) {
                    this._alignBoneWorldDirection(`${prefix}_02_${side}`, p3.clone().sub(p2));
                    this.skinnedMesh.updateMatrixWorld(true);
                }
            }
        };

        applySide('l');
        applySide('r');
        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
    }

    _getFootToeSurfaceData(side) {
        if (!this.THREE || !this.skinnedMesh || !this.bones || !this.boneList) return null;
        const geometry = this.skinnedMesh.geometry;
        const position = geometry?.attributes?.position;
        const skinIndex = geometry?.attributes?.skinIndex;
        const skinWeight = geometry?.attributes?.skinWeight;
        const foot = this.bones[`foot_${side}`];
        const ball = this.bones[`ball_${side}`];
        const initialBallOffset = this.initialBoneStates?.[`ball_${side}`]?.position;
        if (!position || !skinIndex || !skinWeight || !foot || !ball || !initialBallOffset) return null;

        if (this._footToeSurfaceVertexCache?.geometry !== geometry) {
            this._footToeSurfaceVertexCache = { geometry };
        }
        let data = this._footToeSurfaceVertexCache[side];
        if (!data) {
            const footIndex = this.boneList.indexOf(foot);
            const ballIndex = this.boneList.indexOf(ball);
            if (footIndex < 0 || ballIndex < 0) return null;

            const forward = initialBallOffset.clone().normalize();
            const footHead = new this.THREE.Vector3(...(foot.userData?.headPos || [0, 0, 0]));
            const candidates = [];
            const restPoint = new this.THREE.Vector3();
            for (let index = 0; index < position.count; index++) {
                let relatedWeight = 0;
                for (let slot = 0; slot < 4; slot++) {
                    const boneIndex = skinIndex.getComponent(index, slot);
                    if (boneIndex === footIndex || boneIndex === ballIndex) {
                        relatedWeight += skinWeight.getComponent(index, slot);
                    }
                }
                if (relatedWeight < 0.35) continue;
                restPoint.fromBufferAttribute(position, index);
                candidates.push({
                    index,
                    projection: restPoint.clone().sub(footHead).dot(forward),
                });
            }
            candidates.sort((a, b) => b.projection - a.projection);
            const indices = candidates.slice(0, 24).map((item) => item.index);
            if (!indices.length) return null;

            const restAnchor = new this.THREE.Vector3();
            for (const index of indices) {
                restPoint.fromBufferAttribute(position, index);
                restAnchor.add(restPoint);
            }
            restAnchor.multiplyScalar(1 / indices.length);

            // Bones are created in the same unrotated model-space frame as the
            // rest vertices. This vector therefore calibrates the actual end of
            // the rendered toes, rather than the shorter ball_* helper bone.
            const localForward = restAnchor.clone().sub(footHead);
            if (localForward.lengthSq() < 1e-8) localForward.copy(initialBallOffset);
            localForward.normalize();
            const localDorsal = new this.THREE.Vector3(0, 1, 0);
            localDorsal.sub(localForward.clone().multiplyScalar(localDorsal.dot(localForward)));
            if (localDorsal.lengthSq() < 1e-8) localDorsal.set(0, 0, 1);
            localDorsal.normalize();
            const localMedial = new this.THREE.Vector3()
                .crossVectors(localForward, localDorsal)
                .normalize();
            data = { indices, restAnchor, localForward, localDorsal, localMedial };
            this._footToeSurfaceVertexCache[side] = data;
        }
        return data;
    }

    _getCurrentFootToeSurfaceAnchor(side) {
        const data = this._getFootToeSurfaceData(side);
        const position = this.skinnedMesh?.geometry?.attributes?.position;
        if (!data?.indices?.length || !position || typeof this.skinnedMesh.applyBoneTransform !== 'function') {
            return null;
        }

        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();
        const anchor = new this.THREE.Vector3();
        const point = new this.THREE.Vector3();
        for (const index of data.indices) {
            point.fromBufferAttribute(position, index);
            this.skinnedMesh.applyBoneTransform(index, point);
            point.applyMatrix4(this.skinnedMesh.matrixWorld);
            anchor.add(point);
        }
        return anchor.multiplyScalar(1 / data.indices.length);
    }

    _applySAM3DFootPointRetarget(worldKps, footLocalRotations = null) {
        if (!this.THREE || !this.bones || !this.skinnedMesh || !worldKps) return;

        const applySide = (side) => {
            const footName = `foot_${side}`;
            const foot = this.bones?.[footName];
            const ballName = `ball_${side}`;
            const ball = this.bones?.[ballName] || foot?.children?.find((item) => item?.isBone) || null;
            if (!foot || !ball) return;

            const ankle = worldKps[side === 'l' ? 'left_ankle' : 'right_ankle'];
            const bigToe = worldKps[side === 'l' ? 'left_big_toe' : 'right_big_toe'];
            const smallToe = worldKps[side === 'l' ? 'left_small_toe' : 'right_small_toe'];
            const heel = worldKps[side === 'l' ? 'left_heel' : 'right_heel'];
            const knee = worldKps[side === 'l' ? 'left_knee' : 'right_knee'];
            if (!ankle || !bigToe || !smallToe) return;

            const toeCenter = bigToe.clone().add(smallToe).multiplyScalar(0.5);
            const surfaceData = this._getFootToeSurfaceData(side);
            const initialBallOffset = this.initialBoneStates?.[ballName]?.position || ball.position;
            const localForward = surfaceData?.localForward?.clone() || initialBallOffset.clone().normalize();
            const localDorsal = surfaceData?.localDorsal?.clone() || new this.THREE.Vector3(0, 1, 0);
            localDorsal.sub(localForward.clone().multiplyScalar(localDorsal.dot(localForward)));
            if (localForward.lengthSq() < 1e-8 || localDorsal.lengthSq() < 1e-8) return;
            localForward.normalize();
            localDorsal.normalize();
            const localMedial = new this.THREE.Vector3()
                .crossVectors(localForward, localDorsal)
                .normalize();

            // foot_* is the ankle pivot. Its child ball_* must aim from that
            // pivot to the SAM toe centre; heel->toe is a sole direction and is
            // not a valid ankle-bone target (it lifts/twists the whole foot).
            const targetForward = toeCenter.clone().sub(ankle);
            if (targetForward.lengthSq() < 1e-8) return;
            targetForward.normalize();

            const toeWidth = bigToe.clone().sub(smallToe).normalize();
            const soleDirection = heel ? toeCenter.clone().sub(heel) : targetForward.clone();
            let targetDorsal = new this.THREE.Vector3().crossVectors(toeWidth, soleDirection);
            targetDorsal.sub(targetForward.clone().multiplyScalar(targetDorsal.dot(targetForward)));
            if (targetDorsal.lengthSq() < 1e-8) {
                targetDorsal.crossVectors(toeWidth, targetForward);
            }
            if (targetDorsal.lengthSq() < 1e-8) return;
            targetDorsal.normalize();

            // The toe triangle has two valid normals. SAM joint rotation is used
            // only to select the correct half-space after its forward axis has been
            // aligned to the heel-to-toe vector. This preserves SAM's sole/top
            // choice without trusting its incompatible MHR foot bone axes.
            const importedLocalRotation = footLocalRotations?.[footName];
            if (importedLocalRotation && foot.parent) {
                const hintedWorld = foot.parent.getWorldQuaternion(new this.THREE.Quaternion())
                    .multiply(importedLocalRotation.clone())
                    .normalize();
                const hintedForward = localForward.clone().applyQuaternion(hintedWorld).normalize();
                const hintedDorsal = localDorsal.clone().applyQuaternion(hintedWorld).normalize();
                const forwardCorrection = new this.THREE.Quaternion()
                    .setFromUnitVectors(hintedForward, targetForward);
                hintedDorsal.applyQuaternion(forwardCorrection);
                if (targetDorsal.dot(hintedDorsal) < 0) targetDorsal.negate();
            } else if (knee) {
                const targetTowardKnee = knee.clone().sub(ankle);
                targetTowardKnee.sub(targetForward.clone().multiplyScalar(targetTowardKnee.dot(targetForward)));
                if (targetTowardKnee.lengthSq() > 1e-8 && targetDorsal.dot(targetTowardKnee) < 0) {
                    targetDorsal.negate();
                }
            }

            const targetMedial = new this.THREE.Vector3().crossVectors(targetForward, targetDorsal).normalize();

            const localBasis = new this.THREE.Matrix4().makeBasis(localMedial, localForward, localDorsal);
            const targetBasis = new this.THREE.Matrix4().makeBasis(targetMedial, targetForward, targetDorsal);
            const localBasisRotation = new this.THREE.Quaternion().setFromRotationMatrix(localBasis).normalize();
            const targetBasisRotation = new this.THREE.Quaternion().setFromRotationMatrix(targetBasis).normalize();
            const desiredWorldRotation = targetBasisRotation.multiply(localBasisRotation.invert()).normalize();

            this._setBoneWorldQuaternion(foot, desiredWorldRotation);
            this.skinnedMesh.updateMatrixWorld(true);

            // foot_* is already at the SAM ankle because the leg IK ran before
            // this method. Rotate and uniformly scale the rendered foot around
            // that fixed pivot so its real toe surface reaches the SAM toe. Never
            // translate the ankle target and never change calf/foot bone offsets.
            const targetLength = ankle.distanceTo(toeCenter);
            if (targetLength > 1e-6 && surfaceData) {
                for (let pass = 0; pass < 4; pass++) {
                    const footPosition = foot.getWorldPosition(new this.THREE.Vector3());
                    const currentToe = this._getCurrentFootToeSurfaceAnchor(side);
                    if (!currentToe) break;
                    const currentVector = currentToe.sub(footPosition);
                    const currentLength = currentVector.length();
                    if (currentLength < 1e-6) break;

                    const directionCorrection = new this.THREE.Quaternion().setFromUnitVectors(
                        currentVector.clone().multiplyScalar(1 / currentLength),
                        targetForward
                    );
                    if (directionCorrection.angleTo(new this.THREE.Quaternion()) > 1e-7) {
                        const currentWorld = foot.getWorldQuaternion(new this.THREE.Quaternion());
                        this._setBoneWorldQuaternion(
                            foot,
                            directionCorrection.multiply(currentWorld).normalize()
                        );
                    }

                    const scaleRatio = targetLength / currentLength;
                    if (Number.isFinite(scaleRatio) && Math.abs(scaleRatio - 1) > 1e-5) {
                        foot.scale.multiplyScalar(Math.max(0.5, Math.min(2, scaleRatio)));
                    }
                    this.skinnedMesh.updateMatrixWorld(true);
                }
            }
        };

        applySide('l');
        applySide('r');
        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
    }

    _applySAM3DHeadLineRetarget(worldKps) {
        if (!this.THREE || !this.bones?.head || !worldKps) return;

        if (this._applySAM3DEyePairRetarget(worldKps)) {
            if (this.skeleton) this.skeleton.update();
            this.skinnedMesh.updateMatrixWorld(true);
        }
    }

    _applySAM3DHeadPitchBias(degrees = 0) {
        const head = this.bones?.head;
        if (!this.THREE || !head || !this.modelLandmarks) return false;

        const face = this._getCurrentMHFaceLandmarkPoints();
        if (!face) return false;

        const eyeAxis = face.right.clone().sub(face.left);
        const eyeMid = face.left.clone().add(face.right).multiplyScalar(0.5);
        const faceForward = face.nose.clone().sub(eyeMid);
        if (eyeAxis.lengthSq() < 1e-8 || faceForward.lengthSq() < 1e-8) return false;

        eyeAxis.normalize();
        const angle = Math.abs(degrees) * Math.PI / 180;
        const plus = new this.THREE.Quaternion().setFromAxisAngle(eyeAxis, angle).normalize();
        const minus = new this.THREE.Quaternion().setFromAxisAngle(eyeAxis, -angle).normalize();
        const plusForward = faceForward.clone().applyQuaternion(plus);
        const minusForward = faceForward.clone().applyQuaternion(minus);
        const delta = plusForward.y >= minusForward.y ? plus : minus;

        const applied = this._applyBoneWorldDelta(head, delta);
        if (applied) {
            if (this.skeleton) this.skeleton.update();
            this.skinnedMesh.updateMatrixWorld(true);
        }
        return applied;
    }

    _transformRestPointByBone(boneName, restPoint) {
        const bone = this.bones?.[boneName];
        if (!this.THREE || !this.skeleton || !bone || !Array.isArray(restPoint) || restPoint.length < 3) return null;
        const boneIndex = this.boneList.indexOf(bone);
        const inverseBind = this.skeleton.boneInverses?.[boneIndex];
        if (boneIndex < 0 || !inverseBind) return null;
        return new this.THREE.Vector3(restPoint[0], restPoint[1], restPoint[2])
            .applyMatrix4(inverseBind)
            .applyMatrix4(bone.matrixWorld);
    }

    _transformLandmarkVertices(name) {
        const indices = this.modelLandmarkIndices?.[name];
        const geometry = this.skinnedMesh?.geometry;
        const position = geometry?.attributes?.position;
        if (!this.THREE || !this.skinnedMesh || !position || !Array.isArray(indices) || !indices.length) return null;

        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();

        const sum = new this.THREE.Vector3();
        const point = new this.THREE.Vector3();
        let count = 0;
        for (const rawIndex of indices) {
            const index = Number(rawIndex);
            if (!Number.isInteger(index) || index < 0 || index >= position.count) continue;
            point.fromBufferAttribute(position, index);
            if (typeof this.skinnedMesh.applyBoneTransform === 'function') {
                this.skinnedMesh.applyBoneTransform(index, point);
            }
            point.applyMatrix4(this.skinnedMesh.matrixWorld);
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) continue;
            sum.add(point);
            count += 1;
        }
        return count ? sum.multiplyScalar(1 / count) : null;
    }

    _buildFaceBasis(leftEye, rightEye, nose) {
        if (!this.THREE || !leftEye || !rightEye || !nose) return null;
        const THREE = this.THREE;
        const center = leftEye.clone().add(rightEye).multiplyScalar(0.5);
        const xAxis = rightEye.clone().sub(leftEye);
        if (xAxis.lengthSq() < 1e-8) return null;
        xAxis.normalize();

        const downAxis = nose.clone().sub(center);
        downAxis.sub(xAxis.clone().multiplyScalar(downAxis.dot(xAxis)));
        if (downAxis.lengthSq() < 1e-8) return null;
        downAxis.normalize();

        const yAxis = downAxis.clone().negate();
        const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis);
        if (zAxis.lengthSq() < 1e-8) return null;
        zAxis.normalize();
        return new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
    }

    _getSAM3DFaceLandmarkTargets(worldKps) {
        if (!worldKps) return null;
        const left = worldKps.canonical_left_eye || worldKps.left_eye;
        const right = worldKps.canonical_right_eye || worldKps.right_eye;
        const nose = worldKps.canonical_nose || worldKps.nose;
        if (!left || !right || !nose) return null;
        return { left, right, nose };
    }

    _getSAM3DEyeTargets(worldKps) {
        if (!worldKps) return null;
        const left = worldKps.canonical_left_eye || worldKps.left_eye;
        const right = worldKps.canonical_right_eye || worldKps.right_eye;
        if (!left || !right) return null;
        return { left, right };
    }

    _relocateSAM3DEyeTargetsToHead(worldKps, target, currentHeadPivot) {
        if (!this.THREE || !target?.left || !target?.right || !currentHeadPivot) return target;
        const sourceHeadPivot = worldKps?.head || worldKps?.neck_tail || worldKps?.neck;
        if (!sourceHeadPivot) return target;

        const translation = currentHeadPivot.clone().sub(sourceHeadPivot);
        return {
            left: target.left.clone().add(translation),
            right: target.right.clone().add(translation),
        };
    }

    _faceBasisQuaternion(points) {
        if (!this.THREE || !points?.left || !points?.right || !points?.nose) return null;
        const basis = this._buildFaceBasis(points.left, points.right, points.nose);
        if (!basis) return null;
        return new this.THREE.Quaternion().setFromRotationMatrix(basis).normalize();
    }

    _faceUpBasisQuaternion(points, upAnchor) {
        if (!this.THREE || !points?.left || !points?.right || !upAnchor) return null;
        const eyeMid = points.left.clone().add(points.right).multiplyScalar(0.5);
        const yAxis = eyeMid.clone().sub(upAnchor);
        const xAxis = points.right.clone().sub(points.left);
        if (xAxis.lengthSq() < 1e-8 || yAxis.lengthSq() < 1e-8) return null;

        yAxis.normalize();
        xAxis.sub(yAxis.clone().multiplyScalar(xAxis.dot(yAxis)));
        if (xAxis.lengthSq() < 1e-8) return null;
        xAxis.normalize();

        const zAxis = new this.THREE.Vector3().crossVectors(xAxis, yAxis);
        if (zAxis.lengthSq() < 1e-8) return null;
        zAxis.normalize();

        return new this.THREE.Quaternion()
            .setFromRotationMatrix(new this.THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis))
            .normalize();
    }

    _applySAM3DFaceBasisRetarget(worldKps) {
        const head = this.bones?.head;
        if (!this.THREE || !head || !this.modelLandmarks) return false;

        const target = this._getSAM3DFaceLandmarkTargets(worldKps);
        const current = this._getCurrentMHFaceLandmarkPoints();
        if (!target || !current) return false;

        const targetSwapped = { left: target.right, right: target.left, nose: target.nose };
        const selectedTarget = this._faceLandmarkDirectionError(current, targetSwapped) < this._faceLandmarkDirectionError(current, target)
            ? targetSwapped
            : target;

        let applied = false;
        for (let pass = 0; pass < 3; pass++) {
            const sourceNow = this._getCurrentMHFaceLandmarkPoints();
            if (!sourceNow) break;

            const sourceQuat = this._faceBasisQuaternion(sourceNow);
            const targetQuat = this._faceBasisQuaternion(selectedTarget);
            if (!sourceQuat || !targetQuat) break;

            const delta = targetQuat.clone().multiply(sourceQuat.clone().invert()).normalize();
            const angle = 2 * Math.acos(Math.max(-1, Math.min(1, Math.abs(delta.w))));
            if (!Number.isFinite(angle) || angle < 1e-4) break;

            applied = this._applyBoneWorldDelta(head, delta) || applied;
            this.skinnedMesh.updateMatrixWorld(true);
        }

        return applied;
    }

    _applySAM3DEyePairRetarget(worldKps) {
        const head = this.bones?.head;
        if (!this.THREE || !head || !this.modelLandmarks) return false;

        const target = this._getSAM3DEyeTargets(worldKps);
        if (!target) return false;

        let applied = false;
        for (let pass = 0; pass < 6; pass++) {
            const current = this._getCurrentMHFaceLandmarkPoints();
            if (!current?.left || !current?.right) break;

            const currentMid = current.left.clone().add(current.right).multiplyScalar(0.5);
            const headPivot = new this.THREE.Vector3();
            head.getWorldPosition(headPivot);
            const relocatedTarget = this._relocateSAM3DEyeTargetsToHead(
                worldKps,
                target,
                headPivot,
            );
            const targetMid = relocatedTarget.left.clone().add(relocatedTarget.right).multiplyScalar(0.5);

            const currentLook = currentMid.clone().sub(headPivot);
            const targetLook = targetMid.clone().sub(headPivot);
            if (currentLook.lengthSq() > 1e-8 && targetLook.lengthSq() > 1e-8) {
                const deltaLook = new this.THREE.Quaternion().setFromUnitVectors(
                    currentLook.normalize(),
                    targetLook.normalize(),
                ).normalize();
                applied = this._applyBoneWorldDelta(head, deltaLook) || applied;
                this.skinnedMesh.updateMatrixWorld(true);
            }

            const afterLook = this._getCurrentMHFaceLandmarkPoints();
            if (!afterLook?.left || !afterLook?.right) break;
            const afterMid = afterLook.left.clone().add(afterLook.right).multiplyScalar(0.5);
            const rollAxis = targetMid.clone().sub(headPivot);
            if (rollAxis.lengthSq() <= 1e-8) continue;
            rollAxis.normalize();

            const currentEyeAxis = afterLook.right.clone().sub(afterLook.left);
            const targetEyeAxis = relocatedTarget.right.clone().sub(relocatedTarget.left);
            currentEyeAxis.sub(rollAxis.clone().multiplyScalar(currentEyeAxis.dot(rollAxis)));
            targetEyeAxis.sub(rollAxis.clone().multiplyScalar(targetEyeAxis.dot(rollAxis)));
            if (currentEyeAxis.lengthSq() <= 1e-8 || targetEyeAxis.lengthSq() <= 1e-8) continue;
            currentEyeAxis.normalize();
            targetEyeAxis.normalize();

            const deltaRoll = new this.THREE.Quaternion().setFromUnitVectors(currentEyeAxis, targetEyeAxis).normalize();
            applied = this._applyBoneWorldDelta(head, deltaRoll) || applied;
            this.skinnedMesh.updateMatrixWorld(true);

            const check = this._getCurrentMHFaceLandmarkPoints();
            if (!check?.left || !check?.right) continue;
            const checkMid = check.left.clone().add(check.right).multiplyScalar(0.5);
            const checkLook = checkMid.clone().sub(headPivot);
            const lookError = (
                checkLook.lengthSq() > 1e-8 && targetLook.lengthSq() > 1e-8
                    ? 1 - Math.max(-1, Math.min(1, checkLook.normalize().dot(targetLook.clone().normalize())))
                    : Number.POSITIVE_INFINITY
            );
            const axisError = 1 - Math.max(-1, Math.min(1, check.right.clone().sub(check.left).normalize().dot(targetEyeAxis)));
            if (lookError < 0.002 && axisError < 0.002) break;
        }

        return applied;
    }

    _applySAM3DEyeLinePitchTrim(degrees = 0) {
        const head = this.bones?.head;
        if (!this.THREE || !head || !Number.isFinite(degrees) || Math.abs(degrees) < 1e-6) return false;

        const face = this._getCurrentMHFaceLandmarkPoints();
        if (!face?.left || !face?.right) return false;

        const eyeAxis = face.right.clone().sub(face.left);
        if (eyeAxis.lengthSq() <= 1e-8) return false;
        eyeAxis.normalize();

        const angle = Math.abs(degrees) * Math.PI / 180;
        const plus = new this.THREE.Quaternion().setFromAxisAngle(eyeAxis, angle).normalize();
        const minus = new this.THREE.Quaternion().setFromAxisAngle(eyeAxis, -angle).normalize();

        const sample = face.nose || this._getBoneWorldPositionForImport('head');
        if (!sample) return false;
        const headPivot = new this.THREE.Vector3();
        head.getWorldPosition(headPivot);
        const plusSample = sample.clone().sub(headPivot).applyQuaternion(plus).add(headPivot);
        const minusSample = sample.clone().sub(headPivot).applyQuaternion(minus).add(headPivot);
        const delta = plusSample.y >= minusSample.y ? plus : minus;

        const applied = this._applyBoneWorldDelta(head, delta);
        if (applied) {
            this.skinnedMesh.updateMatrixWorld(true);
            if (this.skeleton) this.skeleton.update();
        }
        return applied;
    }

    _getCurrentMHFaceLandmarkPoints() {
        if (!this.THREE || !this.modelLandmarks) return null;
        const left = this._transformLandmarkVertices('left_eye')
            || this._transformRestPointByBone('head', this.modelLandmarks.left_eye);
        const right = this._transformLandmarkVertices('right_eye')
            || this._transformRestPointByBone('head', this.modelLandmarks.right_eye);
        const nose = this._transformLandmarkVertices('nose')
            || this._transformRestPointByBone('head', this.modelLandmarks.nose);
        if (!left || !right || !nose) return null;
        return { left, right, nose };
    }

    _setBoneWorldQuaternion(bone, worldQuaternion) {
        if (!this.THREE || !bone || !worldQuaternion) return false;
        const parentWorld = new this.THREE.Quaternion();
        if (bone.parent) bone.parent.getWorldQuaternion(parentWorld);
        bone.quaternion.copy(parentWorld.invert().multiply(worldQuaternion.clone()).normalize());
        bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
        bone.updateMatrixWorld(true);
        return true;
    }

    _applyBoneWorldDelta(bone, deltaQuaternion) {
        if (!this.THREE || !bone || !deltaQuaternion) return false;
        const currentWorld = new this.THREE.Quaternion();
        bone.getWorldQuaternion(currentWorld);
        return this._setBoneWorldQuaternion(bone, deltaQuaternion.clone().multiply(currentWorld).normalize());
    }

    _applyBoneVectorAlignment(bone, sourceA, sourceB, targetA, targetB, strength = 1) {
        if (!this.THREE || !bone || !sourceA || !sourceB || !targetA || !targetB) return false;
        const sourceDir = sourceB.clone().sub(sourceA);
        const targetDir = targetB.clone().sub(targetA);
        if (sourceDir.lengthSq() < 1e-8 || targetDir.lengthSq() < 1e-8) return false;
        sourceDir.normalize();
        targetDir.normalize();

        const delta = new this.THREE.Quaternion().setFromUnitVectors(sourceDir, targetDir).normalize();
        if (strength < 1) {
            const partial = new this.THREE.Quaternion();
            partial.slerp(delta, Math.max(0, Math.min(1, strength)));
            delta.copy(partial);
        }
        return this._applyBoneWorldDelta(bone, delta);
    }

    _applyFaceVectorAlignment(sourceA, sourceB, targetA, targetB, strength = 1) {
        return this._applyBoneVectorAlignment(this.bones.head, sourceA, sourceB, targetA, targetB, strength);
    }

    _applySAM3DEyeMidRetarget(worldKps) {
        if (!this.THREE || !this.bones?.head || !worldKps?.canonical_left_eye || !worldKps?.canonical_right_eye) return false;
        const targetEyeMid = worldKps.canonical_left_eye.clone().add(worldKps.canonical_right_eye).multiplyScalar(0.5);
        let applied = false;

        for (let pass = 0; pass < 12; pass++) {
            const current = this._getCurrentMHFaceLandmarkPoints();
            if (!current) return applied;
            const currentEyeMid = current.left.clone().add(current.right).multiplyScalar(0.5);
            const headPivot = new this.THREE.Vector3();
            this.bones.head.getWorldPosition(headPivot);
            applied = this._applyFaceVectorAlignment(headPivot, currentEyeMid, headPivot, targetEyeMid, 1.0) || applied;
            this.skinnedMesh.updateMatrixWorld(true);
        }

        for (let pass = 0; pass < 4; pass++) {
            const current = this._getCurrentMHFaceLandmarkPoints();
            if (!current) break;
            applied = this._applyFaceVectorAlignment(current.left, current.right, worldKps.canonical_left_eye, worldKps.canonical_right_eye, 1.0) || applied;
            this.skinnedMesh.updateMatrixWorld(true);
        }
        return applied;
    }

    _alignNeckWorldBasis(worldKps, strength = 0.75) {
        const neck = this.bones?.neck_01;
        if (!this.THREE || !neck || !worldKps?.neck || !worldKps?.canonical_left_eye || !worldKps?.canonical_right_eye || !worldKps?.canonical_nose) return false;

        const current = this._getCurrentMHFaceLandmarkPoints();
        if (!current) return false;

        const neckPosition = new this.THREE.Vector3();
        neck.getWorldPosition(neckPosition);
        const currentEyeMid = current.left.clone().add(current.right).multiplyScalar(0.5);
        const targetEyeMid = worldKps.canonical_left_eye.clone().add(worldKps.canonical_right_eye).multiplyScalar(0.5);

        const eyeApplied = this._applyBoneVectorAlignment(
            neck,
            neckPosition,
            currentEyeMid,
            worldKps.neck,
            targetEyeMid,
            1.0,
        );
        if (eyeApplied) {
            if (this.skeleton) this.skeleton.update();
            this.skinnedMesh.updateMatrixWorld(true);
            return true;
        }

        const basisCurrent = eyeApplied ? this._getCurrentMHFaceLandmarkPoints() : current;
        if (eyeApplied) neck.getWorldPosition(neckPosition);

        const makeBasis = (origin, leftEye, rightEye, nose) => {
            const eyeMid = leftEye.clone().add(rightEye).multiplyScalar(0.5);
            const up = eyeMid.clone().sub(origin);
            const across = rightEye.clone().sub(leftEye);
            if (up.lengthSq() < 1e-8 || across.lengthSq() < 1e-8) return null;
            up.normalize();
            across.sub(up.clone().multiplyScalar(across.dot(up)));
            if (across.lengthSq() < 1e-8) return null;
            across.normalize();

            const faceForward = nose.clone().sub(eyeMid);
            faceForward.sub(up.clone().multiplyScalar(faceForward.dot(up)));
            faceForward.sub(across.clone().multiplyScalar(faceForward.dot(across)));
            if (faceForward.lengthSq() < 1e-8) {
                faceForward.crossVectors(across, up);
            }
            if (faceForward.lengthSq() < 1e-8) return null;
            faceForward.normalize();

            return new this.THREE.Matrix4().makeBasis(across, up, faceForward);
        };

        const currentBasis = makeBasis(neckPosition, basisCurrent.left, basisCurrent.right, basisCurrent.nose);
        const targetBasis = makeBasis(
            worldKps.neck,
            worldKps.canonical_left_eye,
            worldKps.canonical_right_eye,
            worldKps.canonical_nose,
        );
        if (!currentBasis || !targetBasis) return eyeApplied;

        const deltaMatrix = targetBasis.clone().multiply(currentBasis.clone().transpose());
        const delta = new this.THREE.Quaternion().setFromRotationMatrix(deltaMatrix).normalize();
        const basisStrength = eyeApplied ? strength * 0.35 : strength;
        if (basisStrength < 1) {
            const partial = new this.THREE.Quaternion();
            partial.slerp(delta, Math.max(0, Math.min(1, basisStrength)));
            delta.copy(partial);
        }

        const neckWorld = new this.THREE.Quaternion();
        neck.getWorldQuaternion(neckWorld);

        const parentWorld = new this.THREE.Quaternion();
        if (neck.parent) neck.parent.getWorldQuaternion(parentWorld);
        neck.quaternion.copy(parentWorld.invert().multiply(delta.multiply(neckWorld)).normalize());
        neck.rotation.setFromQuaternion(neck.quaternion, neck.rotation.order);
        neck.updateMatrixWorld(true);
        return true;
    }

    _applySAM3DNeckFaceRetarget(worldKps) {
        const neck = this.bones?.neck_01;
        const head = this.bones?.head;
        if (!this.THREE || !neck || !head || !worldKps?.neck || !worldKps?.neck_tail) return false;

        const neckPosition = new this.THREE.Vector3();
        const headPosition = new this.THREE.Vector3();
        neck.getWorldPosition(neckPosition);
        head.getWorldPosition(headPosition);

        const appliedByBasis = this._alignNeckWorldBasis(worldKps, 0.82);
        if (appliedByBasis) {
            if (this.skeleton) this.skeleton.update();
            this.skinnedMesh.updateMatrixWorld(true);
            return true;
        }

        const applied = this._applyBoneVectorAlignment(
            neck,
            neckPosition,
            headPosition,
            worldKps.neck,
            worldKps.neck_tail,
            1.0,
        );
        if (applied) {
            if (this.skeleton) this.skeleton.update();
            this.skinnedMesh.updateMatrixWorld(true);
        }
        return applied;
    }

    _faceLandmarkDirectionError(source, target) {
        if (!this.THREE || !source || !target) return Number.POSITIVE_INFINITY;
        const sourceEyeMid = source.left.clone().add(source.right).multiplyScalar(0.5);
        const targetEyeMid = target.left.clone().add(target.right).multiplyScalar(0.5);
        const pairs = [
            [source.left.clone().sub(source.right), target.left.clone().sub(target.right)],
            [source.nose.clone().sub(sourceEyeMid), target.nose.clone().sub(targetEyeMid)],
        ];
        let error = 0;
        for (const [sourceVec, targetVec] of pairs) {
            if (sourceVec.lengthSq() < 1e-8 || targetVec.lengthSq() < 1e-8) return Number.POSITIVE_INFINITY;
            sourceVec.normalize();
            targetVec.normalize();
            error += 1 - Math.max(-1, Math.min(1, sourceVec.dot(targetVec)));
        }
        return error;
    }

    _applySAM3DFaceLandmarkRetarget(worldKps, options = {}) {
        if (!this.THREE || !this.bones?.head || !this.modelLandmarks) return false;
        const target = {
            left: worldKps.canonical_left_eye,
            right: worldKps.canonical_right_eye,
            nose: worldKps.canonical_nose,
        };
        if (!target.left || !target.right || !target.nose) return false;

        const source = this._getCurrentMHFaceLandmarkPoints();
        if (!source) return false;
        const swappedTarget = { left: target.right, right: target.left, nose: target.nose };
        const selectedTarget = this._faceLandmarkDirectionError(source, swappedTarget) < this._faceLandmarkDirectionError(source, target)
            ? swappedTarget
            : target;

        const passes = Number.isFinite(options?.passes) ? Math.max(1, Math.floor(options.passes)) : 5;
        const strength = Number.isFinite(options?.strength) ? Math.max(0, Math.min(1, options.strength)) : 1;

        for (let pass = 0; pass < passes; pass++) {
            const currentA = this._getCurrentMHFaceLandmarkPoints();
            if (!currentA) return false;
            const sourceEyeMidA = currentA.left.clone().add(currentA.right).multiplyScalar(0.5);
            const targetEyeMid = selectedTarget.left.clone().add(selectedTarget.right).multiplyScalar(0.5);

            const headPivot = new this.THREE.Vector3();
            this.bones.head.getWorldPosition(headPivot);
            this._applyFaceVectorAlignment(headPivot, sourceEyeMidA, headPivot, targetEyeMid, 0.9 * strength);
            this.skinnedMesh.updateMatrixWorld(true);

            const currentB = this._getCurrentMHFaceLandmarkPoints();
            if (!currentB) return false;
            const currentBEyeMid = currentB.left.clone().add(currentB.right).multiplyScalar(0.5);
            this._applyFaceVectorAlignment(currentBEyeMid, currentB.nose, targetEyeMid, selectedTarget.nose, 0.85 * strength);
            this.skinnedMesh.updateMatrixWorld(true);

            const currentC = this._getCurrentMHFaceLandmarkPoints();
            if (!currentC) return false;
            this._applyFaceVectorAlignment(currentC.left, currentC.right, selectedTarget.left, selectedTarget.right, 0.85 * strength);
            this.skinnedMesh.updateMatrixWorld(true);
        }

        return true;
    }

    _convertSAM3DRotationMatrix(matrixRows) {
        if (!this.THREE || !Array.isArray(matrixRows) || matrixRows.length < 3) return null;

        const rows = matrixRows.map((row) => Array.isArray(row) ? row : null);
        if (rows.some((row) => !row || row.length < 3)) return null;

        const THREE = this.THREE;
        const source = new THREE.Matrix4().set(
            Number(rows[0][0]), Number(rows[0][1]), Number(rows[0][2]), 0,
            Number(rows[1][0]), Number(rows[1][1]), Number(rows[1][2]), 0,
            Number(rows[2][0]), Number(rows[2][1]), Number(rows[2][2]), 0,
            0, 0, 0, 1,
        );
        // Mirror SAM3DBody's Blender exporter:
        // MHR native (X right, Y up, Z forward) -> Blender/MH scene basis
        // (X right, Y back, Z up), then conjugate rotations by that basis.
        const axisSwap = new THREE.Matrix4().set(
            1, 0, 0, 0,
            0, 0, -1, 0,
            0, 1, 0, 0,
            0, 0, 0, 1,
        );
        const axisSwapT = axisSwap.clone().transpose();
        return axisSwap.clone().multiply(source).multiply(axisSwapT);
    }

    _getSAM3DJointName(data, index) {
        if (Array.isArray(data?.joint_names) && data.joint_names[index]) {
            return String(data.joint_names[index]);
        }
        return SAM3D_JOINT_COORD_NAMES[index] || `joint_${String(index).padStart(3, '0')}`;
    }

    _buildSAM3DWorldRotationMap(data) {
        if (!Array.isArray(data?.joint_rotations)) return null;

        const worldRotations = {};
        for (let index = 0; index < data.joint_rotations.length; index++) {
            const boneName = this._getSAM3DJointName(data, index);
            if (!boneName) continue;
            const matrixRows = data.joint_rotations[index];
            const matrix = this._convertSAM3DRotationMatrix(matrixRows);
            if (!matrix) continue;
            worldRotations[boneName] = new this.THREE.Quaternion().setFromRotationMatrix(matrix);
        }
        return Object.keys(worldRotations).length ? worldRotations : null;
    }

    applyWorldRotationImport(sourceWorldRotations, parentMap = DEFAULT_WORLD_ROTATION_PARENT_MAP, rotationOrder = DEFAULT_WORLD_ROTATION_ORDER, options = {}) {
        if (!this.THREE || !this.bones || !this.skinnedMesh || !sourceWorldRotations) return false;

        const sourceRestWorldRotations = options?.sourceRestWorldRotations || null;
        const debugBones = new Set(options?.debugBones || []);
        const debugFrame = options?.debugFrame ?? null;
        const debugCollector = options?.debugCollector || null;

        const quatToArray = (quat) => quat ? [quat.x, quat.y, quat.z, quat.w] : null;
        const quatToEulerDegrees = (quat) => {
            if (!quat) return null;
            const euler = new this.THREE.Euler().setFromQuaternion(quat, 'XYZ');
            return [
                euler.x * 180 / Math.PI,
                euler.y * 180 / Math.PI,
                euler.z * 180 / Math.PI,
            ];
        };

        const targetRestWorldRotations = {};
        for (const boneName of rotationOrder) {
            const quaternion = this._getBoneWorldQuaternionForImport(boneName);
            if (quaternion) targetRestWorldRotations[boneName] = quaternion;
        }

        const appliedTargetWorldRotations = {};

        for (const boneName of rotationOrder) {
            const bone = this.bones[boneName];
            const sourceWorld = sourceWorldRotations[boneName];
            const targetRest = targetRestWorldRotations[boneName];
            if (!bone || !sourceWorld || !targetRest) continue;

            const parentName = parentMap[boneName];
            const targetAppliedParentWorld = parentName
                ? (appliedTargetWorldRotations[parentName] || targetRestWorldRotations[parentName] || null)
                : null;
            let desiredTargetWorld;
            let sourceAnimatedLocal = null;
            let sourceRestLocal = null;
            let sourceLocalDelta = null;
            let targetRestLocal = null;
            let basisDelta = null;
            let retargetedLocalDelta = null;
            let desiredTargetLocal = null;
            if (sourceRestWorldRotations?.[boneName]) {
                const sourceRest = sourceRestWorldRotations[boneName];
                const sourceParentWorld = parentName ? sourceWorldRotations[parentName] : null;
                const sourceRestParentWorld = parentName ? sourceRestWorldRotations[parentName] : null;

                sourceAnimatedLocal = sourceParentWorld
                    ? sourceParentWorld.clone().invert().multiply(sourceWorld.clone()).normalize()
                    : sourceWorld.clone().normalize();
                sourceRestLocal = sourceRestParentWorld
                    ? sourceRestParentWorld.clone().invert().multiply(sourceRest.clone()).normalize()
                    : sourceRest.clone().normalize();

                sourceLocalDelta = sourceRestLocal.clone().invert().multiply(sourceAnimatedLocal).normalize();

                const targetRestParentWorld = parentName ? (targetRestWorldRotations[parentName] || null) : null;
                targetRestLocal = targetRestParentWorld
                    ? targetRestParentWorld.clone().invert().multiply(targetRest.clone()).normalize()
                    : targetRest.clone().normalize();

                // Re-express the source local delta in the target local basis.
                basisDelta = targetRestLocal.clone().invert().multiply(sourceRestLocal.clone()).normalize();
                retargetedLocalDelta = basisDelta.clone()
                    .multiply(sourceLocalDelta)
                    .multiply(basisDelta.clone().invert())
                    .normalize();

                desiredTargetLocal = targetRestLocal.clone().multiply(retargetedLocalDelta).normalize();
                desiredTargetWorld = parentName
                    ? targetAppliedParentWorld.clone().multiply(desiredTargetLocal).normalize()
                    : desiredTargetLocal;
            } else {
                desiredTargetWorld = sourceWorld.clone();
            }

            let parentTargetWorld = null;
            if (parentName) {
                parentTargetWorld = targetAppliedParentWorld;
            }

            const localQuat = parentTargetWorld
                ? parentTargetWorld.clone().invert().multiply(desiredTargetWorld.clone()).normalize()
                : desiredTargetWorld.clone().normalize();

            bone.quaternion.copy(localQuat);
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            bone.updateMatrixWorld(true);

            const appliedWorld = new this.THREE.Quaternion();
            bone.getWorldQuaternion(appliedWorld);
            appliedTargetWorldRotations[boneName] = appliedWorld;

            if (debugCollector && debugBones.has(boneName)) {
                debugCollector[boneName] = {
                    frame: debugFrame,
                    parentName,
                    sourceWorld: quatToArray(sourceWorld),
                    sourceWorldEuler: quatToEulerDegrees(sourceWorld),
                    sourceRestWorld: quatToArray(sourceRestWorldRotations?.[boneName] || null),
                    sourceRestWorldEuler: quatToEulerDegrees(sourceRestWorldRotations?.[boneName] || null),
                    sourceAnimatedLocal: quatToArray(sourceAnimatedLocal),
                    sourceAnimatedLocalEuler: quatToEulerDegrees(sourceAnimatedLocal),
                    sourceRestLocal: quatToArray(sourceRestLocal),
                    sourceRestLocalEuler: quatToEulerDegrees(sourceRestLocal),
                    sourceLocalDelta: quatToArray(sourceLocalDelta),
                    sourceLocalDeltaEuler: quatToEulerDegrees(sourceLocalDelta),
                    targetRestWorld: quatToArray(targetRest),
                    targetRestWorldEuler: quatToEulerDegrees(targetRest),
                    targetRestLocal: quatToArray(targetRestLocal),
                    targetRestLocalEuler: quatToEulerDegrees(targetRestLocal),
                    basisDelta: quatToArray(basisDelta),
                    basisDeltaEuler: quatToEulerDegrees(basisDelta),
                    retargetedLocalDelta: quatToArray(retargetedLocalDelta),
                    retargetedLocalDeltaEuler: quatToEulerDegrees(retargetedLocalDelta),
                    desiredTargetLocal: quatToArray(desiredTargetLocal),
                    desiredTargetLocalEuler: quatToEulerDegrees(desiredTargetLocal),
                    appliedLocal: quatToArray(localQuat),
                    appliedLocalEuler: quatToEulerDegrees(localQuat),
                    appliedWorld: quatToArray(appliedWorld),
                    appliedWorldEuler: quatToEulerDegrees(appliedWorld),
                };
            }
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateIKEffectorPositions();
        return true;
    }

    applyImportedLegTargets(legTargets = {}) {
        if (!this.THREE || !this.bones || !this.skinnedMesh || !this.ikController?.ccdSolver) return false;

        const applyChain = (chainKey, targetDef) => {
            if (!targetDef?.ankleTarget) return false;
            const chainDef = IK_CHAINS[chainKey];
            if (!chainDef) return false;

            const poleHelper = this.ikController?.poleTargets?.[chainKey] || null;
            if (poleHelper && targetDef.kneeTarget) {
                poleHelper.position.copy(targetDef.kneeTarget);
            }

            this.ikController.solveWithPole(chainDef, this.bones, targetDef.ankleTarget, chainKey);
            this.skinnedMesh.updateMatrixWorld(true);
            return true;
        };

        let applied = false;
        for (let pass = 0; pass < 3; pass++) {
            const leftApplied = applyChain('leftLeg', legTargets.leftLeg);
            const rightApplied = applyChain('rightLeg', legTargets.rightLeg);
            applied = leftApplied || rightApplied || applied;
        }

        if (!applied) return false;

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateIKEffectorPositions();
        return true;
    }

    _applySAM3DRotationImport(data) {
        const sourceWorldRotations = this._buildSAM3DWorldRotationMap(data);
        const restJointRotations = data?.rest_joint_rotations || data?.rest_joint_rots || null;
        const sourceRestWorldRotations = restJointRotations
            ? this._buildSAM3DWorldRotationMap({ joint_rotations: restJointRotations, joint_names: data?.joint_names })
            : null;
        if (sourceWorldRotations && sourceRestWorldRotations) {
            return this._applySAM3DHumanoidDeltaImport(sourceWorldRotations, sourceRestWorldRotations);
        }
        return this.applyWorldRotationImport(
            sourceWorldRotations,
            DEFAULT_WORLD_ROTATION_PARENT_MAP,
            DEFAULT_WORLD_ROTATION_ORDER,
            { sourceRestWorldRotations }
        );
    }

    _buildTargetRestMatrix(boneName) {
        if (!this.THREE || !this.bones?.[boneName]) return null;

        const THREE = this.THREE;
        const bone = this.bones[boneName];
        bone.updateMatrixWorld(true);
        return new THREE.Matrix4().extractRotation(bone.matrixWorld);
    }

    _applySAM3DHumanoidDeltaImport(sourceWorldRotations, sourceRestWorldRotations) {
        if (!this.THREE || !this.bones || !this.skinnedMesh || !sourceWorldRotations || !sourceRestWorldRotations) return false;

        const THREE = this.THREE;
        this.skinnedMesh.updateMatrixWorld(true);

        const mappedEntries = Object.entries(SAM3D_TO_MH_BONE_MAP)
            .filter(([sourceName, targetName]) => (
                sourceWorldRotations[sourceName]
                && sourceRestWorldRotations[sourceName]
                && this.bones[targetName]
            ));
        if (!mappedEntries.length) return false;

        const sourceByTarget = {};
        for (const [sourceName, targetName] of mappedEntries) {
            sourceByTarget[targetName] = sourceName;
        }

        const boneDepth = (bone) => {
            let depth = 0;
            let cursor = bone?.parent || null;
            while (cursor) {
                depth += 1;
                cursor = cursor.parent || null;
            }
            return depth;
        };
        mappedEntries.sort((a, b) => boneDepth(this.bones[a[1]]) - boneDepth(this.bones[b[1]]));

        const targetRestMatrices = {};
        for (const [sourceName, targetName] of mappedEntries) {
            if (!targetName || !this.bones[targetName]) continue;
            const matrix = this._buildTargetRestMatrix(targetName);
            if (matrix) targetRestMatrices[sourceName] = matrix;
        }

        for (const [sourceName, targetName] of mappedEntries) {
            const bone = targetName ? this.bones[targetName] : null;
            const M_rj = targetRestMatrices[sourceName];
            const R_rj = sourceRestWorldRotations[sourceName];
            const R_pj = sourceWorldRotations[sourceName];
            if (!bone || !M_rj || !R_rj || !R_pj) continue;

            const parentSourceName = bone.parent ? sourceByTarget[bone.parent.name] : null;
            const M_rj_T = M_rj.clone().transpose();
            const R_rj_T = new THREE.Matrix4().makeRotationFromQuaternion(R_rj).transpose();
            const post_j = R_rj_T.clone().multiply(M_rj);
            const R_pj_M = new THREE.Matrix4().makeRotationFromQuaternion(R_pj);
            let delta;
            if (parentSourceName && sourceRestWorldRotations[parentSourceName] && sourceWorldRotations[parentSourceName]) {
                const pre_j = M_rj_T.clone().multiply(new THREE.Matrix4().makeRotationFromQuaternion(sourceRestWorldRotations[parentSourceName]));
                const R_pp_T = new THREE.Matrix4().makeRotationFromQuaternion(sourceWorldRotations[parentSourceName]).transpose();
                delta = pre_j
                    .multiply(R_pp_T)
                    .multiply(R_pj_M)
                    .multiply(post_j);
            } else {
                delta = M_rj_T
                    .multiply(R_pj_M)
                    .multiply(post_j);
            }

            const localQuat = new THREE.Quaternion().setFromRotationMatrix(delta).normalize();
            bone.quaternion.copy(localQuat);
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            bone.updateMatrixWorld(true);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateIKEffectorPositions();
        return true;
    }

    _buildSAM3DImportTargets(data) {
        if (!this.THREE || !this.bones || !this.ikController) return null;

        const THREE = this.THREE;
        const namedPoints = this._buildSAM3DNamedPoints(data);
        const pelvisSource = this._averageSAM3DPoint(namedPoints, ['left_hip', 'right_hip']) || namedPoints.pelvis;
        if (!pelvisSource) return null;

        const pelvisWorld = this._getBoneWorldPositionForImport('pelvis') || this._getBoneWorldPositionForImport('spine_01');
        if (!pelvisWorld) return null;

        const rest = {
            pelvis: pelvisWorld.clone(),
            neck: this._getBoneWorldPositionForImport('neck_01'),
            head: this._getBoneWorldPositionForImport('head'),
            leftShoulder: this._getBoneWorldPositionForImport('upperarm_l'),
            rightShoulder: this._getBoneWorldPositionForImport('upperarm_r'),
            leftElbow: this._getBoneWorldPositionForImport('lowerarm_l'),
            rightElbow: this._getBoneWorldPositionForImport('lowerarm_r'),
            leftHand: this._getBoneWorldPositionForImport('hand_l'),
            rightHand: this._getBoneWorldPositionForImport('hand_r'),
            leftHip: this._getBoneWorldPositionForImport('thigh_l'),
            rightHip: this._getBoneWorldPositionForImport('thigh_r'),
            leftKnee: this._getBoneWorldPositionForImport('calf_l'),
            rightKnee: this._getBoneWorldPositionForImport('calf_r'),
            leftFoot: this._getBoneWorldPositionForImport('foot_l'),
            rightFoot: this._getBoneWorldPositionForImport('foot_r'),
            leftToe: this._getBoneWorldPositionForImport('ball_l'),
            rightToe: this._getBoneWorldPositionForImport('ball_r'),
        };

        const neckChildIndex = this._pickSAM3DChainChildIndex(data, 110);
        const source = {
            neck: namedPoints.neck_01 || namedPoints.neck || this._averageSAM3DPoint(namedPoints, ['left_shoulder', 'right_shoulder']),
            neckTail: this._pickSAM3DChainChildPoint(data, namedPoints, 110),
            restNeck: this._getSAM3DPointByIndex(data?.rest_joint_coords, 110),
            restNeckTail: this._getSAM3DPointByIndex(data?.rest_joint_coords, neckChildIndex),
            head: namedPoints.head || this._averageSAM3DPoint(namedPoints, ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear']) || namedPoints.nose,
            leftShoulder: namedPoints.upperarm_l || namedPoints.left_acromion || namedPoints.left_shoulder,
            rightShoulder: namedPoints.upperarm_r || namedPoints.right_acromion || namedPoints.right_shoulder,
            leftElbow: namedPoints.lowerarm_l || namedPoints.left_elbow || namedPoints.left_olecranon || namedPoints.left_cubital_fossa,
            rightElbow: namedPoints.lowerarm_r || namedPoints.right_elbow || namedPoints.right_olecranon || namedPoints.right_cubital_fossa,
            leftHand: namedPoints.left_wrist || namedPoints.hand_l,
            rightHand: namedPoints.right_wrist || namedPoints.hand_r,
            leftHip: namedPoints.left_hip || namedPoints.thigh_l,
            rightHip: namedPoints.right_hip || namedPoints.thigh_r,
            leftKnee: namedPoints.calf_l || namedPoints.left_knee,
            rightKnee: namedPoints.calf_r || namedPoints.right_knee,
            leftFoot: namedPoints.left_ankle || namedPoints.foot_l,
            rightFoot: namedPoints.right_ankle || namedPoints.foot_r,
            leftBigToe: namedPoints.left_big_toe,
            leftSmallToe: namedPoints.left_small_toe,
            leftHeel: namedPoints.left_heel,
            rightBigToe: namedPoints.right_big_toe,
            rightSmallToe: namedPoints.right_small_toe,
            rightHeel: namedPoints.right_heel,
            leftEar: namedPoints.left_ear,
            rightEar: namedPoints.right_ear,
            nose: namedPoints.canonical_nose || namedPoints.nose,
            canonicalNeck: namedPoints.canonical_neck,
            canonicalLeftEye: namedPoints.canonical_left_eye,
            canonicalRightEye: namedPoints.canonical_right_eye,
            canonicalLeftEar: namedPoints.canonical_left_ear,
            canonicalRightEar: namedPoints.canonical_right_ear,
        };

        const sourceVector = (from, to) => {
            if (!from || !to) return null;
            return [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        };
        const vectorLength = (vector) => {
            if (!vector) return 0;
            return Math.hypot(vector[0], vector[1], vector[2]);
        };
        const worldDistance = (from, to) => (from && to ? from.distanceTo(to) : 0);
        const transformedOffset = (vector, scale) => new THREE.Vector3(vector[0] * scale, vector[1] * scale, vector[2] * scale);
        const scaledWorldPoint = (worldAnchor, sourceAnchor, sourcePoint, scale) => {
            if (!worldAnchor || !sourceAnchor || !sourcePoint) return null;
            return worldAnchor.clone().add(transformedOffset(sourceVector(sourceAnchor, sourcePoint), scale));
        };
        const vectorFromArray = (vector) => vector ? new THREE.Vector3(vector[0], vector[1], vector[2]) : null;
        const deltaRetargetedWorldPoint = (worldAnchor, targetRestAnchor, targetRestPoint, sourceRestAnchor, sourceRestPoint, sourcePoseAnchor, sourcePosePoint) => {
            if (!worldAnchor || !targetRestAnchor || !targetRestPoint) return null;
            const targetRestVector = targetRestPoint.clone().sub(targetRestAnchor);
            const sourceRestVector = vectorFromArray(sourceVector(sourceRestAnchor, sourceRestPoint));
            const sourcePoseVector = vectorFromArray(sourceVector(sourcePoseAnchor, sourcePosePoint));
            if (!targetRestVector || !sourceRestVector || !sourcePoseVector) return null;
            if (targetRestVector.lengthSq() < 1e-8 || sourceRestVector.lengthSq() < 1e-8 || sourcePoseVector.lengthSq() < 1e-8) return null;
            sourceRestVector.normalize();
            sourcePoseVector.normalize();
            const delta = new THREE.Quaternion().setFromUnitVectors(sourceRestVector, sourcePoseVector).normalize();
            return worldAnchor.clone().add(targetRestVector.applyQuaternion(delta));
        };
        const segmentWorldPoint = (worldAnchor, sourceAnchor, sourcePoint, targetLength) => {
            const vector = sourceVector(sourceAnchor, sourcePoint);
            const length = vectorLength(vector);
            if (!worldAnchor || !vector || length <= 1e-5 || targetLength <= 1e-5) return null;
            return worldAnchor.clone().add(transformedOffset(vector, targetLength / length));
        };
        const scaleBetween = (sourceAnchor, sourcePoint, worldAnchor, worldPoint, fallback) => {
            const sourceLen = vectorLength(sourceVector(sourceAnchor, sourcePoint));
            const worldLen = worldDistance(worldAnchor, worldPoint);
            if (sourceLen > 1e-5 && worldLen > 1e-5) return worldLen / sourceLen;
            return fallback;
        };

        const torsoScale = scaleBetween(pelvisSource, source.neck || source.head, rest.pelvis, rest.neck || rest.head, 1.0);
        const headScale = scaleBetween(source.neck || pelvisSource, source.head, rest.neck || rest.pelvis, rest.head, torsoScale);
        const leftArmScale = scaleBetween(source.leftShoulder || pelvisSource, source.leftHand, rest.leftShoulder || rest.pelvis, rest.leftHand, torsoScale);
        const rightArmScale = scaleBetween(source.rightShoulder || pelvisSource, source.rightHand, rest.rightShoulder || rest.pelvis, rest.rightHand, torsoScale);
        const leftLegScale = scaleBetween(source.leftHip || pelvisSource, source.leftFoot, rest.leftHip || rest.pelvis, rest.leftFoot, torsoScale);
        const rightLegScale = scaleBetween(source.rightHip || pelvisSource, source.rightFoot, rest.rightHip || rest.pelvis, rest.rightFoot, torsoScale);

        const worldKps = {
            pelvis: rest.pelvis.clone(),
            neck: scaledWorldPoint(rest.pelvis, pelvisSource, source.neck, torsoScale),
            left_shoulder: scaledWorldPoint(rest.pelvis, pelvisSource, source.leftShoulder, torsoScale),
            right_shoulder: scaledWorldPoint(rest.pelvis, pelvisSource, source.rightShoulder, torsoScale),
            left_hip: scaledWorldPoint(rest.pelvis, pelvisSource, source.leftHip, torsoScale),
            right_hip: scaledWorldPoint(rest.pelvis, pelvisSource, source.rightHip, torsoScale),
            left_ear: scaledWorldPoint(rest.pelvis, pelvisSource, source.leftEar, torsoScale),
            right_ear: scaledWorldPoint(rest.pelvis, pelvisSource, source.rightEar, torsoScale),
            nose: scaledWorldPoint(rest.neck || rest.pelvis, source.neck || pelvisSource, source.nose, headScale),
        };

        worldKps.head = scaledWorldPoint(rest.neck || rest.pelvis, source.neck || pelvisSource, source.head, headScale);
        worldKps.neck_tail = deltaRetargetedWorldPoint(
            worldKps.neck || rest.neck || rest.pelvis,
            rest.neck,
            rest.head,
            source.restNeck,
            source.restNeckTail,
            source.neck || pelvisSource,
            source.neckTail,
        ) || segmentWorldPoint(
            worldKps.neck || rest.neck || rest.pelvis,
            source.neck || pelvisSource,
            source.neckTail,
            worldDistance(rest.neck, rest.head),
        ) || scaledWorldPoint(
            worldKps.neck || rest.neck || rest.pelvis,
            source.neck || pelvisSource,
            source.neckTail,
            headScale,
        );
        const faceAnchor = source.canonicalNeck || source.neck || pelvisSource;
        const faceWorldAnchor = source.canonicalNeck
            ? scaledWorldPoint(rest.pelvis, pelvisSource, source.canonicalNeck, torsoScale)
            : (worldKps.neck || rest.neck || rest.pelvis);
        const faceScale = scaleBetween(
            faceAnchor,
            source.nose || source.canonicalLeftEye || source.canonicalRightEye,
            faceWorldAnchor,
            rest.head || worldKps.head,
            headScale,
        );
        const addFacePoint = (worldName, sourcePoint) => {
            const point = scaledWorldPoint(faceWorldAnchor, faceAnchor, sourcePoint, faceScale);
            if (point) worldKps[worldName] = point;
        };
        addFacePoint('canonical_nose', source.nose);
        addFacePoint('canonical_left_eye', source.canonicalLeftEye);
        addFacePoint('canonical_right_eye', source.canonicalRightEye);
        addFacePoint('canonical_left_ear', source.canonicalLeftEar);
        addFacePoint('canonical_right_ear', source.canonicalRightEar);
        const leftUpperArmLen = worldDistance(rest.leftShoulder, rest.leftElbow);
        const rightUpperArmLen = worldDistance(rest.rightShoulder, rest.rightElbow);
        const leftLowerArmLen = worldDistance(rest.leftElbow, rest.leftHand);
        const rightLowerArmLen = worldDistance(rest.rightElbow, rest.rightHand);
        const leftThighLen = worldDistance(rest.leftHip, rest.leftKnee);
        const rightThighLen = worldDistance(rest.rightHip, rest.rightKnee);
        const leftCalfLen = worldDistance(rest.leftKnee, rest.leftFoot);
        const rightCalfLen = worldDistance(rest.rightKnee, rest.rightFoot);

        worldKps.left_elbow = segmentWorldPoint(worldKps.left_shoulder || rest.leftShoulder, source.leftShoulder || pelvisSource, source.leftElbow, leftUpperArmLen)
            || scaledWorldPoint(worldKps.left_shoulder || rest.leftShoulder, source.leftShoulder || pelvisSource, source.leftElbow, leftArmScale);
        worldKps.right_elbow = segmentWorldPoint(worldKps.right_shoulder || rest.rightShoulder, source.rightShoulder || pelvisSource, source.rightElbow, rightUpperArmLen)
            || scaledWorldPoint(worldKps.right_shoulder || rest.rightShoulder, source.rightShoulder || pelvisSource, source.rightElbow, rightArmScale);
        this._relaxSAM3DShoulderTargets(worldKps, rest);
        worldKps.left_wrist = segmentWorldPoint(worldKps.left_elbow || worldKps.left_shoulder || rest.leftShoulder, source.leftElbow || source.leftShoulder || pelvisSource, source.leftHand, leftLowerArmLen)
            || scaledWorldPoint(worldKps.left_elbow || worldKps.left_shoulder || rest.leftShoulder, source.leftElbow || source.leftShoulder || pelvisSource, source.leftHand, leftArmScale);
        worldKps.right_wrist = segmentWorldPoint(worldKps.right_elbow || worldKps.right_shoulder || rest.rightShoulder, source.rightElbow || source.rightShoulder || pelvisSource, source.rightHand, rightLowerArmLen)
            || scaledWorldPoint(worldKps.right_elbow || worldKps.right_shoulder || rest.rightShoulder, source.rightElbow || source.rightShoulder || pelvisSource, source.rightHand, rightArmScale);
        worldKps.left_knee = segmentWorldPoint(worldKps.left_hip || rest.leftHip, source.leftHip || pelvisSource, source.leftKnee, leftThighLen)
            || scaledWorldPoint(worldKps.left_hip || rest.leftHip, source.leftHip || pelvisSource, source.leftKnee, leftLegScale);
        worldKps.right_knee = segmentWorldPoint(worldKps.right_hip || rest.rightHip, source.rightHip || pelvisSource, source.rightKnee, rightThighLen)
            || scaledWorldPoint(worldKps.right_hip || rest.rightHip, source.rightHip || pelvisSource, source.rightKnee, rightLegScale);
        worldKps.left_ankle = segmentWorldPoint(worldKps.left_knee || worldKps.left_hip || rest.leftHip, source.leftKnee || source.leftHip || pelvisSource, source.leftFoot, leftCalfLen)
            || scaledWorldPoint(worldKps.left_knee || worldKps.left_hip || rest.leftHip, source.leftKnee || source.leftHip || pelvisSource, source.leftFoot, leftLegScale);
        worldKps.right_ankle = segmentWorldPoint(worldKps.right_knee || worldKps.right_hip || rest.rightHip, source.rightKnee || source.rightHip || pelvisSource, source.rightFoot, rightCalfLen)
            || scaledWorldPoint(worldKps.right_knee || worldKps.right_hip || rest.rightHip, source.rightKnee || source.rightHip || pelvisSource, source.rightFoot, rightLegScale);

        const leftFootScale = scaleBetween(source.leftFoot, source.leftBigToe || source.leftSmallToe, rest.leftFoot, rest.leftToe, leftLegScale);
        const rightFootScale = scaleBetween(source.rightFoot, source.rightBigToe || source.rightSmallToe, rest.rightFoot, rest.rightToe, rightLegScale);
        worldKps.left_big_toe = scaledWorldPoint(worldKps.left_ankle || rest.leftFoot, source.leftFoot, source.leftBigToe, leftFootScale);
        worldKps.left_small_toe = scaledWorldPoint(worldKps.left_ankle || rest.leftFoot, source.leftFoot, source.leftSmallToe, leftFootScale);
        worldKps.left_heel = scaledWorldPoint(worldKps.left_ankle || rest.leftFoot, source.leftFoot, source.leftHeel, leftFootScale);
        worldKps.right_big_toe = scaledWorldPoint(worldKps.right_ankle || rest.rightFoot, source.rightFoot, source.rightBigToe, rightFootScale);
        worldKps.right_small_toe = scaledWorldPoint(worldKps.right_ankle || rest.rightFoot, source.rightFoot, source.rightSmallToe, rightFootScale);
        worldKps.right_heel = scaledWorldPoint(worldKps.right_ankle || rest.rightFoot, source.rightFoot, source.rightHeel, rightFootScale);

        if (!worldKps.neck && worldKps.left_shoulder && worldKps.right_shoulder) {
            worldKps.neck = new THREE.Vector3(
                (worldKps.left_shoulder.x + worldKps.right_shoulder.x) / 2,
                (worldKps.left_shoulder.y + worldKps.right_shoulder.y) / 2,
                (worldKps.left_shoulder.z + worldKps.right_shoulder.z) / 2,
            );
        }
        if (!worldKps.head && worldKps.neck && worldKps.nose) {
            worldKps.head = worldKps.nose.clone();
        }

        const addFingerPoints = (side) => {
            const wristKey = side === 'l' ? 'left_wrist' : 'right_wrist';
            const sourceWrist = side === 'l' ? source.leftHand : source.rightHand;
            const restWrist = side === 'l' ? rest.leftHand : rest.rightHand;
            const scale = side === 'l' ? leftArmScale : rightArmScale;
            const wristWorld = worldKps[wristKey] || restWrist;
            if (!wristWorld || !sourceWrist) return;

            for (const prefix of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
                let previousWorld = wristWorld;
                let previousSource = sourceWrist;
                for (let index = 1; index <= 3; index++) {
                    const name = `${prefix}_0${index}_${side}`;
                    const point = namedPoints[name];
                    if (!point) continue;
                    const nextWorld = scaledWorldPoint(previousWorld, previousSource, point, scale);
                    if (!nextWorld) continue;
                    worldKps[name] = nextWorld;
                    previousWorld = nextWorld;
                    previousSource = point;
                }
            }
        };

        addFingerPoints('l');
        addFingerPoints('r');

        return {
            worldKps,
            effectorTargets: {
                pelvis: rest.pelvis.clone(),
                hand_l: worldKps.left_wrist || rest.leftHand,
                hand_r: worldKps.right_wrist || rest.rightHand,
                foot_l: worldKps.left_ankle || rest.leftFoot,
                foot_r: worldKps.right_ankle || rest.rightFoot,
                upperarm_l: worldKps.left_shoulder || rest.leftShoulder,
                upperarm_r: worldKps.right_shoulder || rest.rightShoulder,
            },
            poleTargets: {
                leftArm: worldKps.left_elbow || null,
                rightArm: worldKps.right_elbow || null,
                leftLeg: worldKps.left_knee || null,
                rightLeg: worldKps.right_knee || null,
            },
        };
    }

    _relaxSAM3DShoulderTargets(worldKps, rest) {
        if (!worldKps || !rest?.neck) return;
        const neck = worldKps.neck || rest.neck;
        if (!neck) return;

        const applySide = (side) => {
            const shoulderKey = side === 'l' ? 'left_shoulder' : 'right_shoulder';
            const elbowKey = side === 'l' ? 'left_elbow' : 'right_elbow';
            const handKey = side === 'l' ? 'left_wrist' : 'right_wrist';
            const restShoulder = side === 'l' ? rest.leftShoulder : rest.rightShoulder;
            const shoulder = worldKps[shoulderKey];
            if (!shoulder || !restShoulder) return;

            const restDrop = Math.max(0.05, rest.neck.y - restShoulder.y);
            const elbow = worldKps[elbowKey];
            const hand = worldKps[handKey];
            const armRaised = (
                (elbow && elbow.y > shoulder.y + restDrop * 0.25)
                || (hand && hand.y > shoulder.y + restDrop * 0.5)
            );
            const maxShoulderY = neck.y - restDrop * (armRaised ? 0.30 : 0.55);
            if (shoulder.y > maxShoulderY) {
                const deltaY = maxShoulderY - shoulder.y;
                shoulder.y = maxShoulderY;
                if (elbow) elbow.y += deltaY;
            }
        };

        applySide('l');
        applySide('r');
    }

    autoFitSAM3DBoneLengths(data) {
        if (!this.THREE || !this.bones || !this.skinnedMesh || !data) return null;

        const namedPoints = this._buildSAM3DNamedPoints(data);
        const distArray = (a, b) => {
            if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) return 0;
            return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        };
        const distWorld = (a, b) => (a && b ? a.distanceTo(b) : 0);
        const sliderFromScale = (scale) => {
            if (!Number.isFinite(scale)) return 0.5;
            return Math.max(0, Math.min(1, scale - 0.5));
        };

        const rest = {
            leftShoulder: this._getBoneWorldPositionForImport('upperarm_l'),
            rightShoulder: this._getBoneWorldPositionForImport('upperarm_r'),
            leftElbow: this._getBoneWorldPositionForImport('lowerarm_l'),
            rightElbow: this._getBoneWorldPositionForImport('lowerarm_r'),
            leftHand: this._getBoneWorldPositionForImport('hand_l'),
            rightHand: this._getBoneWorldPositionForImport('hand_r'),
            leftHip: this._getBoneWorldPositionForImport('thigh_l'),
            rightHip: this._getBoneWorldPositionForImport('thigh_r'),
            leftKnee: this._getBoneWorldPositionForImport('calf_l'),
            rightKnee: this._getBoneWorldPositionForImport('calf_r'),
            leftFoot: this._getBoneWorldPositionForImport('foot_l'),
            rightFoot: this._getBoneWorldPositionForImport('foot_r'),
            pelvis: this._getBoneWorldPositionForImport('pelvis') || this._getBoneWorldPositionForImport('spine_01'),
            spine2: this._getBoneWorldPositionForImport('spine_02'),
            spine3: this._getBoneWorldPositionForImport('spine_03'),
        };

        const sourceShoulderWidth = distArray(namedPoints.left_shoulder || namedPoints.upperarm_l, namedPoints.right_shoulder || namedPoints.upperarm_r);
        const sourceHipWidth = distArray(namedPoints.left_hip || namedPoints.thigh_l, namedPoints.right_hip || namedPoints.thigh_r);
        const restShoulderWidth = distWorld(rest.leftShoulder, rest.rightShoulder);
        const restHipWidth = distWorld(rest.leftHip, rest.rightHip);
        const torsoScales = [];
        if (sourceShoulderWidth > 1e-5 && restShoulderWidth > 1e-5) torsoScales.push(restShoulderWidth / sourceShoulderWidth);
        if (sourceHipWidth > 1e-5 && restHipWidth > 1e-5) torsoScales.push(restHipWidth / sourceHipWidth);
        const worldScale = torsoScales.length
            ? torsoScales.reduce((sum, value) => sum + value, 0) / torsoScales.length
            : 1.0;

        const fitChain = (sourceRoot, sourceMid, sourceEnd, restRoot, restMid, restEnd) => {
            const sourceUpper = distArray(sourceRoot, sourceMid);
            const sourceLower = distArray(sourceMid, sourceEnd);
            const restUpper = distWorld(restRoot, restMid);
            const restLower = distWorld(restMid, restEnd);
            if (
                sourceUpper <= 1e-5
                || sourceLower <= 1e-5
                || restUpper <= 1e-5
                || restLower <= 1e-5
            ) {
                return [0.5, 0.5];
            }
            return [
                sliderFromScale((sourceUpper * worldScale) / restUpper),
                sliderFromScale((sourceLower * worldScale) / restLower),
            ];
        };

        const [leftUpperArm, leftForearm] = fitChain(
            namedPoints.left_shoulder || namedPoints.upperarm_l,
            namedPoints.left_elbow || namedPoints.lowerarm_l,
            namedPoints.left_wrist || namedPoints.hand_l,
            rest.leftShoulder,
            rest.leftElbow,
            rest.leftHand,
        );
        const [rightUpperArm, rightForearm] = fitChain(
            namedPoints.right_shoulder || namedPoints.upperarm_r,
            namedPoints.right_elbow || namedPoints.lowerarm_r,
            namedPoints.right_wrist || namedPoints.hand_r,
            rest.rightShoulder,
            rest.rightElbow,
            rest.rightHand,
        );
        const [leftThigh, leftShin] = fitChain(
            namedPoints.left_hip || namedPoints.thigh_l,
            namedPoints.left_knee || namedPoints.calf_l,
            namedPoints.left_ankle || namedPoints.foot_l,
            rest.leftHip,
            rest.leftKnee,
            rest.leftFoot,
        );
        const [rightThigh, rightShin] = fitChain(
            namedPoints.right_hip || namedPoints.thigh_r,
            namedPoints.right_knee || namedPoints.calf_r,
            namedPoints.right_ankle || namedPoints.foot_r,
            rest.rightHip,
            rest.rightKnee,
            rest.rightFoot,
        );

        const fitted = {
            upper_arm_l: leftUpperArm,
            upper_arm_r: rightUpperArm,
            forearm_l: leftForearm,
            forearm_r: rightForearm,
            thigh_l: leftThigh,
            thigh_r: rightThigh,
            shin_l: leftShin,
            shin_r: rightShin,
            spine: 0.5,
        };

        for (const [group, value] of Object.entries(fitted)) {
            this.updateBoneLengthScale(group, value);
        }
        this.lastAutoBoneLengthParams = { ...fitted };
        return fitted;
    }

    _applyImportPelvisAndTorso(worldKps, shoulderYOffset = 0, options = {}) {
        if (!worldKps || !this.THREE || !this.bones || !this.skinnedMesh) return;

        const THREE = this.THREE;
        const pelvisBone = this.bones.pelvis || this.bones.spine_01;
        if (pelvisBone && worldKps.pelvis) {
            const localTarget = worldKps.pelvis.clone();
            if (pelvisBone.parent) pelvisBone.parent.worldToLocal(localTarget);
            pelvisBone.position.copy(localTarget);
            this.skinnedMesh.updateMatrixWorld(true);

            const rightHip = worldKps.right_hip;
            const leftHip = worldKps.left_hip;
            const neck = worldKps.neck;
            if (rightHip && leftHip && neck) {
                const pelvisRight = new THREE.Vector3().subVectors(leftHip, rightHip).normalize();
                const pelvisUp = new THREE.Vector3().subVectors(neck, worldKps.pelvis);
                if (pelvisUp.y < 0) pelvisUp.negate();
                pelvisUp.sub(pelvisRight.clone().multiplyScalar(pelvisUp.dot(pelvisRight))).normalize();
                const pelvisForward = new THREE.Vector3().crossVectors(pelvisRight, pelvisUp).normalize();
                const rotationMatrix = new THREE.Matrix4().makeBasis(pelvisRight, pelvisUp, pelvisForward);
                const worldQuat = new THREE.Quaternion().setFromRotationMatrix(rotationMatrix);
                const parentWorldQuat = new THREE.Quaternion();
                if (pelvisBone.parent) pelvisBone.parent.getWorldQuaternion(parentWorldQuat);
                pelvisBone.quaternion.copy(parentWorldQuat.clone().invert().multiply(worldQuat));
                pelvisBone.rotation.setFromQuaternion(pelvisBone.quaternion, pelvisBone.rotation.order);
                this.skinnedMesh.updateMatrixWorld(true);
            }
        }

        const childBoneMap = {
            spine_01: 'spine_02',
            spine_02: 'spine_03',
            spine_03: 'neck_01',
            neck_01: 'head',
            clavicle_r: 'upperarm_r',
            clavicle_l: 'upperarm_l',
        };

        const applyFK = (boneName, parentKpName, childKpName, targetFromBoneOrigin = false) => {
            const parentPoint = worldKps[parentKpName];
            const childPoint = worldKps[childKpName];
            const bone = this.bones[boneName];
            if (!parentPoint || !childPoint || !bone) return;

            const boneWorldPosition = new THREE.Vector3();
            bone.getWorldPosition(boneWorldPosition);
            const targetOrigin = targetFromBoneOrigin ? boneWorldPosition : parentPoint;
            const targetDir = new THREE.Vector3().subVectors(childPoint, targetOrigin).normalize();
            if (targetDir.lengthSq() < 0.001) return;

            const childBone = childBoneMap[boneName] ? this.bones[childBoneMap[boneName]] : null;
            const currentDir = new THREE.Vector3();
            if (childBone) {
                const bonePos = new THREE.Vector3();
                const childPos = new THREE.Vector3();
                bone.getWorldPosition(bonePos);
                childBone.getWorldPosition(childPos);
                currentDir.copy(childPos.clone().sub(bonePos).normalize());
            } else {
                bone.getWorldDirection(currentDir);
            }
            if (currentDir.lengthSq() < 0.001) return;

            const boneWorldQuat = new THREE.Quaternion();
            bone.getWorldQuaternion(boneWorldQuat);
            const deltaQuat = new THREE.Quaternion().setFromUnitVectors(currentDir, targetDir);
            const newWorldQuat = deltaQuat.multiply(boneWorldQuat);
            const parentWorldQuat = new THREE.Quaternion();
            if (bone.parent) bone.parent.getWorldQuaternion(parentWorldQuat);
            bone.quaternion.copy(parentWorldQuat.clone().invert().multiply(newWorldQuat));
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            this.skinnedMesh.updateMatrixWorld(true);
        };

        if (worldKps.pelvis && worldKps.neck) {
            worldKps._s1 = worldKps.pelvis.clone().lerp(worldKps.neck, 1 / 3);
            worldKps._s2 = worldKps.pelvis.clone().lerp(worldKps.neck, 2 / 3);
            applyFK('spine_01', 'pelvis', '_s1');
            applyFK('spine_02', '_s1', '_s2');
            applyFK('spine_03', '_s2', 'neck');
        }

        if (shoulderYOffset !== 0) {
            if (worldKps.right_shoulder) worldKps.right_shoulder = worldKps.right_shoulder.clone().setY(worldKps.right_shoulder.y + shoulderYOffset);
            if (worldKps.left_shoulder) worldKps.left_shoulder = worldKps.left_shoulder.clone().setY(worldKps.left_shoulder.y + shoulderYOffset);
        }

        applyFK('clavicle_r', 'neck', 'right_shoulder', true);
        applyFK('clavicle_l', 'neck', 'left_shoulder', true);
    }

    _buildWorldKeypointsFromSAM3D(data) {
        const namedPoints = this._buildSAM3DNamedPoints(data);
        const leftHip = namedPoints.left_hip;
        const rightHip = namedPoints.right_hip;
        const pelvisSource = leftHip && rightHip
            ? [
                (leftHip[0] + rightHip[0]) / 2,
                (leftHip[1] + rightHip[1]) / 2,
                (leftHip[2] + rightHip[2]) / 2,
            ]
            : (namedPoints.pelvis || null);

        if (!pelvisSource) return null;

        let mannequinPelvis = new this.THREE.Vector3(0, 0, 0);
        const pelvisBone = this.bones.pelvis || this.bones.spine_01;
        if (pelvisBone) pelvisBone.getWorldPosition(mannequinPelvis);

        const sourceHeightKeys = [
            'head', 'neck', 'left_shoulder', 'right_shoulder',
            'left_hip', 'right_hip', 'left_knee', 'right_knee',
            'left_ankle', 'right_ankle',
        ];
        const sourceHeights = sourceHeightKeys
            .map((name) => namedPoints[name])
            .filter((point) => Array.isArray(point))
            .map((point) => point[1]);

        const sourceHeight = sourceHeights.length >= 2
            ? Math.max(...sourceHeights) - Math.min(...sourceHeights)
            : 0;
        const targetHeight = this._estimateCurrentModelHeight();
        const scale = sourceHeight > 1e-4 ? targetHeight / sourceHeight : 1.0;

        const toWorld = (point) => {
            if (!Array.isArray(point) || point.length < 3) return null;
            return new this.THREE.Vector3(
                mannequinPelvis.x + (point[0] - pelvisSource[0]) * scale,
                mannequinPelvis.y + (point[1] - pelvisSource[1]) * scale,
                mannequinPelvis.z + (point[2] - pelvisSource[2]) * scale,
            );
        };

        const worldKps = {
            pelvis: toWorld(pelvisSource),
            nose: toWorld(namedPoints.head || namedPoints.nose),
            neck: toWorld(namedPoints.neck || (namedPoints.neck_01 || null)),
            left_shoulder: toWorld(namedPoints.left_shoulder),
            right_shoulder: toWorld(namedPoints.right_shoulder),
            left_elbow: toWorld(namedPoints.left_elbow),
            right_elbow: toWorld(namedPoints.right_elbow),
            left_wrist: toWorld(namedPoints.left_wrist || namedPoints.hand_l),
            right_wrist: toWorld(namedPoints.right_wrist || namedPoints.hand_r),
            left_hip: toWorld(namedPoints.left_hip || namedPoints.thigh_l),
            right_hip: toWorld(namedPoints.right_hip || namedPoints.thigh_r),
            left_knee: toWorld(namedPoints.left_knee || namedPoints.calf_l),
            right_knee: toWorld(namedPoints.right_knee || namedPoints.calf_r),
            left_ankle: toWorld(namedPoints.left_ankle || namedPoints.foot_l),
            right_ankle: toWorld(namedPoints.right_ankle || namedPoints.foot_r),
            left_ear: toWorld(namedPoints.left_ear),
            right_ear: toWorld(namedPoints.right_ear),
            left_eye: toWorld(namedPoints.left_eye),
            right_eye: toWorld(namedPoints.right_eye),
        };

        for (const name of SAM3D_FINGER_POINT_NAMES) {
            const point = toWorld(namedPoints[name]);
            if (point) worldKps[name] = point;
        }

        if (!worldKps.neck && worldKps.left_shoulder && worldKps.right_shoulder) {
            worldKps.neck = new this.THREE.Vector3(
                (worldKps.left_shoulder.x + worldKps.right_shoulder.x) / 2,
                (worldKps.left_shoulder.y + worldKps.right_shoulder.y) / 2,
                (worldKps.left_shoulder.z + worldKps.right_shoulder.z) / 2,
            );
        }

        return worldKps;
    }

    _applySAM3DTargetIK(importTargets, options = {}) {
        if (!this.ikController || !this.bones || !this.skinnedMesh || !importTargets) return;

        const includeSpine = options.includeSpine !== false;
        const normalizeLimbs = options.normalizeLimbs !== false;
        const normalizeArms = normalizeLimbs && options.normalizeArms !== false;
        const normalizeLegs = normalizeLimbs && options.normalizeLegs !== false;
        const setEffectorTarget = (name, target) => {
            const effector = this.ikController?.effectors?.[name];
            if (effector && target) effector.position.copy(target);
        };
        const getBonePos = (name) => this._getBoneWorldPositionForImport(name);
        const dist = (a, b) => (a && b ? a.distanceTo(b) : 0);
        const sourceDir = (from, to, fallback) => {
            if (from && to) {
                const dir = to.clone().sub(from);
                if (dir.lengthSq() > 1e-8) return dir.normalize();
            }
            if (fallback && fallback.lengthSq() > 1e-8) return fallback.clone().normalize();
            return null;
        };
        const normalizedTargets = {
            effectorTargets: { ...(importTargets.effectorTargets || {}) },
            poleTargets: { ...(importTargets.poleTargets || {}) },
            worldKps: importTargets.worldKps ? { ...importTargets.worldKps } : null,
        };

        const normalizeChain = (def) => {
            const worldKps = importTargets.worldKps;
            if (!worldKps) return;
            const root = getBonePos(def.rootBone);
            const midRest = getBonePos(def.midBone);
            const endRest = getBonePos(def.endBone);
            if (!root || !midRest || !endRest || !worldKps[def.rootKp] || !worldKps[def.midKp] || !worldKps[def.endKp]) return;

            const upperLen = dist(root, midRest);
            const lowerLen = dist(midRest, endRest);
            if (upperLen <= 1e-5 || lowerLen <= 1e-5) return;

            const currentRootToMid = midRest.clone().sub(root);
            const dirA = sourceDir(worldKps[def.rootKp], worldKps[def.midKp], currentRootToMid);
            if (!dirA) return;
            const mid = root.clone().add(dirA.multiplyScalar(upperLen));
            const currentMidToEnd = endRest.clone().sub(midRest);
            const dirB = sourceDir(worldKps[def.midKp], worldKps[def.endKp], currentMidToEnd);
            if (!dirB) return;
            const end = mid.clone().add(dirB.multiplyScalar(lowerLen));

            normalizedTargets.poleTargets[def.chainKey] = mid;
            normalizedTargets.effectorTargets[def.effectorName] = end;
            if (normalizedTargets.worldKps) {
                const oldMid = normalizedTargets.worldKps[def.midKp] || null;
                const oldEnd = normalizedTargets.worldKps[def.endKp] || null;
                normalizedTargets.worldKps[def.midKp] = mid;
                normalizedTargets.worldKps[def.endKp] = end;
                if (oldMid && oldEnd && Array.isArray(def.attachedPoints)) {
                    const oldDir = oldEnd.clone().sub(oldMid);
                    const newDir = end.clone().sub(mid);
                    const rotateAttached = oldDir.lengthSq() > 1e-8 && newDir.lengthSq() > 1e-8
                        ? new this.THREE.Quaternion().setFromUnitVectors(oldDir.clone().normalize(), newDir.clone().normalize())
                        : null;
                    const attachedScale = oldDir.lengthSq() > 1e-8
                        ? Math.sqrt(newDir.lengthSq() / oldDir.lengthSq())
                        : 1;
                    for (const name of def.attachedPoints) {
                        const point = normalizedTargets.worldKps[name];
                        if (!point) continue;
                        const offset = point.clone().sub(oldEnd).multiplyScalar(attachedScale);
                        if (rotateAttached) offset.applyQuaternion(rotateAttached);
                        normalizedTargets.worldKps[name] = end.clone().add(offset);
                    }
                }
            }
        };

        for (const [name, target] of Object.entries(importTargets.effectorTargets || {})) {
            setEffectorTarget(name, target);
        }
        for (const [chainKey, poleTarget] of Object.entries(importTargets.poleTargets || {})) {
            const helper = this.ikController?.poleTargets?.[chainKey];
            if (helper && poleTarget) helper.position.copy(poleTarget);
        }

        if (importTargets.effectorTargets?.upperarm_r) {
            this.ikController.ccdSolver.solve(IK_CHAINS.rightShoulder, this.bones, importTargets.effectorTargets.upperarm_r);
            this.skinnedMesh.updateMatrixWorld(true);
        }
        if (importTargets.effectorTargets?.upperarm_l) {
            this.ikController.ccdSolver.solve(IK_CHAINS.leftShoulder, this.bones, importTargets.effectorTargets.upperarm_l);
            this.skinnedMesh.updateMatrixWorld(true);
        }
        if (includeSpine && importTargets.effectorTargets?.head) {
            this.ikController.ccdSolver.solve(IK_CHAINS.spine, this.bones, importTargets.effectorTargets.head);
            this.skinnedMesh.updateMatrixWorld(true);
        }

        if (normalizeLimbs) {
            if (normalizeArms) {
                normalizeChain({
                    chainKey: 'rightArm',
                    rootBone: 'upperarm_r',
                    midBone: 'lowerarm_r',
                    endBone: 'hand_r',
                    rootKp: 'right_shoulder',
                    midKp: 'right_elbow',
                    endKp: 'right_wrist',
                    effectorName: 'hand_r',
                    attachedPoints: SAM3D_FINGER_POINT_NAMES.filter((name) => name.endsWith('_r')),
                });
                normalizeChain({
                    chainKey: 'leftArm',
                    rootBone: 'upperarm_l',
                    midBone: 'lowerarm_l',
                    endBone: 'hand_l',
                    rootKp: 'left_shoulder',
                    midKp: 'left_elbow',
                    endKp: 'left_wrist',
                    effectorName: 'hand_l',
                    attachedPoints: SAM3D_FINGER_POINT_NAMES.filter((name) => name.endsWith('_l')),
                });
            }
            if (normalizeLegs) {
                normalizeChain({
                    chainKey: 'rightLeg',
                    rootBone: 'thigh_r',
                    midBone: 'calf_r',
                    endBone: 'foot_r',
                    rootKp: 'right_hip',
                    midKp: 'right_knee',
                    endKp: 'right_ankle',
                    effectorName: 'foot_r',
                    attachedPoints: SAM3D_FOOT_POINT_NAMES.filter((name) => name.startsWith('right_')),
                });
                normalizeChain({
                    chainKey: 'leftLeg',
                    rootBone: 'thigh_l',
                    midBone: 'calf_l',
                    endBone: 'foot_l',
                    rootKp: 'left_hip',
                    midKp: 'left_knee',
                    endKp: 'left_ankle',
                    effectorName: 'foot_l',
                    attachedPoints: SAM3D_FOOT_POINT_NAMES.filter((name) => name.startsWith('left_')),
                });
            }
            if (normalizedTargets.worldKps) {
                importTargets.worldKps = normalizedTargets.worldKps;
                if (options.drawNormalizedFigure !== false) {
                    this._hmr2WorldKps = normalizedTargets.worldKps;
                    this._drawHMR2Figure(normalizedTargets.worldKps);
                }
            }
        }

        const ikFinishing = [
            { chainKey: 'rightArm', effectorName: 'hand_r' },
            { chainKey: 'leftArm', effectorName: 'hand_l' },
            { chainKey: 'rightLeg', effectorName: 'foot_r' },
            { chainKey: 'leftLeg', effectorName: 'foot_l' },
        ];
        for (const { chainKey, effectorName } of ikFinishing) {
            const chainDef = IK_CHAINS[chainKey];
            const target = normalizedTargets.effectorTargets?.[effectorName];
            const poleTarget = normalizedTargets.poleTargets?.[chainKey] || null;
            if (!chainDef || !target) continue;
            this.ikController.ccdSolver.solve(chainDef, this.bones, target, poleTarget);
            this.skinnedMesh.updateMatrixWorld(true);
        }
    }

    applySAM3DImport(data, shoulderYOffset = 0, options = {}) {
        if (!this.THREE || !this.bones || !this.skinnedMesh) return false;

        if (options.recordState !== false) this.recordState();
        this._sam3dImportedFootLocalRotations = null;
        this.modelRotation = { x: 0, y: 0, z: 0 };
        if (this.skinnedMesh) {
            this.skinnedMesh.rotation.set(0, 0, 0);
        }
        for (const bone of this.boneList) {
            if (bone.name === 'Root') continue;
            bone.quaternion.set(0, 0, 0, 1);
            bone.rotation.set(0, 0, 0);
            if (this.initialBoneStates && this.initialBoneStates[bone.name]) {
                bone.position.copy(this.initialBoneStates[bone.name].position);
            }
        }
        // Foot surface fitting changes foot bone scale. It is derived from one
        // pose and must never be multiplied into the next video sample.
        const configuredFootScale = Number(this.footScale);
        const baseFootScale = Number.isFinite(configuredFootScale) && configuredFootScale > 0
            ? configuredFootScale
            : 1.0;
        for (const footName of ['foot_l', 'foot_r']) {
            this.bones?.[footName]?.scale?.set?.(baseFootScale, baseFootScale, baseFootScale);
        }
        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();

        // Match the mannequin's limb proportions to the fitted SAM skeleton
        // before building IK targets. Position/scale differences should be
        // handled by body proportions and camera framing, not knee flexion.
        if (options.fitBoneLengths !== false) {
            this.autoFitSAM3DBoneLengths(data);
        } else {
            // Video frames share one character rig. Reapply the already chosen
            // proportions after the pose reset instead of deriving a new body
            // shape from every independently analysed frame.
            this.applyBoneLengthScales();
        }

        const importTargets = this._buildSAM3DImportTargets(data);
        const worldKps = importTargets?.worldKps;

        const usedRotationImport = this._applySAM3DRotationImport(data);
        if (usedRotationImport) {
            const footLocalRotations = {};
            for (const footName of ['foot_l', 'foot_r']) {
                const foot = this.bones?.[footName];
                if (!foot) continue;
                footLocalRotations[footName] = foot.quaternion.clone();
            }
            if (Object.keys(footLocalRotations).length) {
                this._sam3dImportedFootLocalRotations = footLocalRotations;
            }
        }

        if (worldKps?.pelvis) {
            return this.applyWorldKeypointImport(worldKps, {
                shoulderYOffset,
                includeSpine: !usedRotationImport,
                normalizeLimbs: true,
                normalizeArms: true,
                normalizeLegs: true,
                placeHipRoots: options.placeHipRoots !== false,
                // Dense MHR rotations already carry the head orientation. The
                // eye midpoint is not a compatible head-pivot target and can
                // tip/flip the MakeHuman head on rear views.
                alignHead: options.alignHead ?? !usedRotationImport,
                alignFeet: options.alignFeet !== false,
                footLocalRotations: this._sam3dImportedFootLocalRotations,
                dispatchPoseChange: options.dispatchPoseChange !== false,
            });
        }

        if (usedRotationImport) {
            if (this.skeleton) this.skeleton.update();
            this.skinnedMesh.updateMatrixWorld(true);
            this.updateMarkers();
            this.requestRender();
            if (options.dispatchPoseChange !== false) this.dispatchPoseChange();
            return true;
        }
        return false;
    }

    applyHMR2v1Import(data, smplRefHeight = 1.45, shoulderYOffset = 0) {
        if (!this.THREE || !this.bones || !this.skinnedMesh) return false;

        const people = data?.people || [];
        const person = people[0];
        const kp3d = person?.keypoints_3d;
        if (!kp3d) return false;

        let mannequinPelvis = new this.THREE.Vector3(0, 0, 0);
        const pelvisBone = this.bones.pelvis || this.bones.spine_01;
        if (pelvisBone) pelvisBone.getWorldPosition(mannequinPelvis);

        const targetHeight = this._estimateCurrentModelHeight();
        const smplScale = targetHeight / Math.max(0.1, smplRefHeight || 1.45);
        const smplPelvis = kp3d.pelvis || [0, 0, 0];

        const worldKps = {};
        for (const [name, xyz] of Object.entries(kp3d)) {
            if (!Array.isArray(xyz) || xyz.length < 3) continue;
            worldKps[name] = new this.THREE.Vector3(
                mannequinPelvis.x + (xyz[0] - smplPelvis[0]) * smplScale,
                mannequinPelvis.y - (xyz[1] - smplPelvis[1]) * smplScale,
                mannequinPelvis.z - (xyz[2] - smplPelvis[2]) * smplScale,
            );
        }

        this._hmr2WorldKps = worldKps;
        this._drawHMR2Figure(worldKps);
        this.fitMannequinToHMR2(shoulderYOffset);
        return true;
    }

    fitMannequinToHMR2(shoulderYOffset = 0) {
        if (!this._hmr2WorldKps || !this.bones || !this.ikController || !this.skinnedMesh) return;

        const THREE = this.THREE;
        const worldKps = this._hmr2WorldKps;

        this.recordState();
        for (const bone of this.boneList) {
            if (bone.name === 'Root') continue;
            bone.quaternion.set(0, 0, 0, 1);
            bone.rotation.set(0, 0, 0);
            if (this.initialBoneStates && this.initialBoneStates[bone.name]) {
                bone.position.copy(this.initialBoneStates[bone.name].position);
            }
        }
        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();

        const pelvisBone = this.bones.pelvis || this.bones.spine_01;
        if (pelvisBone && worldKps.pelvis) {
            const localTarget = worldKps.pelvis.clone();
            if (pelvisBone.parent) pelvisBone.parent.worldToLocal(localTarget);
            pelvisBone.position.copy(localTarget);
            this.skinnedMesh.updateMatrixWorld(true);

            const rightHip = worldKps.right_hip;
            const leftHip = worldKps.left_hip;
            const neck = worldKps.neck;
            if (rightHip && leftHip && neck) {
                const pelvisRight = new THREE.Vector3().subVectors(leftHip, rightHip).normalize();
                const pelvisUp = new THREE.Vector3().subVectors(neck, worldKps.pelvis);
                if (pelvisUp.y < 0) pelvisUp.negate();
                pelvisUp.sub(pelvisRight.clone().multiplyScalar(pelvisUp.dot(pelvisRight))).normalize();
                const pelvisForward = new THREE.Vector3().crossVectors(pelvisRight, pelvisUp).normalize();
                const rotationMatrix = new THREE.Matrix4().makeBasis(pelvisRight, pelvisUp, pelvisForward);
                const worldQuat = new THREE.Quaternion().setFromRotationMatrix(rotationMatrix);
                const parentWorldQuat = new THREE.Quaternion();
                if (pelvisBone.parent) pelvisBone.parent.getWorldQuaternion(parentWorldQuat);
                pelvisBone.quaternion.copy(parentWorldQuat.clone().invert().multiply(worldQuat));
                pelvisBone.rotation.setFromQuaternion(pelvisBone.quaternion, pelvisBone.rotation.order);
                this.skinnedMesh.updateMatrixWorld(true);
            }
        }

        const childBoneMap = {
            spine_01: 'spine_02',
            spine_02: 'spine_03',
            spine_03: 'neck_01',
            neck_01: 'head',
            clavicle_r: 'upperarm_r',
            clavicle_l: 'upperarm_l',
            upperarm_r: 'lowerarm_r',
            lowerarm_r: 'hand_r',
            upperarm_l: 'lowerarm_l',
            lowerarm_l: 'hand_l',
            thigh_r: 'calf_r',
            calf_r: 'foot_r',
            thigh_l: 'calf_l',
            calf_l: 'foot_l',
        };

        const applyFK = (boneName, parentKpName, childKpName) => {
            const parentPoint = worldKps[parentKpName];
            const childPoint = worldKps[childKpName];
            const bone = this.bones[boneName];
            if (!parentPoint || !childPoint || !bone) return;

            const targetDir = new THREE.Vector3().subVectors(childPoint, parentPoint).normalize();
            if (targetDir.lengthSq() < 0.001) return;

            const childBone = childBoneMap[boneName] ? this.bones[childBoneMap[boneName]] : null;
            let currentDir = new THREE.Vector3();
            if (childBone) {
                const bonePos = new THREE.Vector3();
                const childPos = new THREE.Vector3();
                bone.getWorldPosition(bonePos);
                childBone.getWorldPosition(childPos);
                currentDir = childPos.clone().sub(bonePos).normalize();
            } else {
                bone.getWorldDirection(currentDir);
            }
            if (currentDir.lengthSq() < 0.001) return;

            const boneWorldQuat = new THREE.Quaternion();
            bone.getWorldQuaternion(boneWorldQuat);
            const deltaQuat = new THREE.Quaternion().setFromUnitVectors(currentDir, targetDir);
            const newWorldQuat = deltaQuat.multiply(boneWorldQuat);
            const parentWorldQuat = new THREE.Quaternion();
            if (bone.parent) bone.parent.getWorldQuaternion(parentWorldQuat);
            bone.quaternion.copy(parentWorldQuat.clone().invert().multiply(newWorldQuat));
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            this.skinnedMesh.updateMatrixWorld(true);
        };

        if (worldKps.pelvis && worldKps.neck) {
            worldKps._s1 = worldKps.pelvis.clone().lerp(worldKps.neck, 1 / 3);
            worldKps._s2 = worldKps.pelvis.clone().lerp(worldKps.neck, 2 / 3);
            applyFK('spine_01', 'pelvis', '_s1');
            applyFK('spine_02', '_s1', '_s2');
            applyFK('spine_03', '_s2', 'neck');
        }

        const rightEar = worldKps.right_ear;
        const leftEar = worldKps.left_ear;
        if (rightEar && leftEar) {
            worldKps._earMid = new THREE.Vector3(
                (rightEar.x + leftEar.x) / 2,
                (rightEar.y + leftEar.y) / 2,
                (rightEar.z + leftEar.z) / 2,
            );
        }
        if (worldKps._earMid) {
            applyFK('neck_01', 'neck', '_earMid');
            if (worldKps.nose) applyFK('head', '_earMid', 'nose');
        } else {
            applyFK('neck_01', 'neck', 'nose');
        }

        if (shoulderYOffset !== 0) {
            if (worldKps.right_shoulder) worldKps.right_shoulder = worldKps.right_shoulder.clone().setY(worldKps.right_shoulder.y + shoulderYOffset);
            if (worldKps.left_shoulder) worldKps.left_shoulder = worldKps.left_shoulder.clone().setY(worldKps.left_shoulder.y + shoulderYOffset);
        }

        applyFK('clavicle_r', 'neck', 'right_shoulder');
        applyFK('clavicle_l', 'neck', 'left_shoulder');
        applyFK('upperarm_r', 'right_shoulder', 'right_elbow');
        applyFK('lowerarm_r', 'right_elbow', 'right_wrist');
        applyFK('upperarm_l', 'left_shoulder', 'left_elbow');
        applyFK('lowerarm_l', 'left_elbow', 'left_wrist');
        applyFK('thigh_r', 'right_hip', 'right_knee');
        applyFK('calf_r', 'right_knee', 'right_ankle');
        applyFK('thigh_l', 'left_hip', 'left_knee');
        applyFK('calf_l', 'left_knee', 'left_ankle');

        const ikFinishing = [
            { chainKey: 'rightArm', target: worldKps.right_wrist },
            { chainKey: 'leftArm', target: worldKps.left_wrist },
            { chainKey: 'rightLeg', target: worldKps.right_ankle },
            { chainKey: 'leftLeg', target: worldKps.left_ankle },
        ];
        for (const { chainKey, target } of ikFinishing) {
            if (!target) continue;
            const chainDef = IK_CHAINS[chainKey];
            if (!chainDef) continue;
            this.ikController.solveWithPole(chainDef, this.bones, target, chainKey);
            this.skinnedMesh.updateMatrixWorld(true);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.updateIKEffectorPositions();
        this.requestRender();
        this.dispatchPoseChange();
    }

    setMannequinVisible(visible) {
        this._mannequinVisible = visible;
        if (this.skinnedMesh) this.skinnedMesh.visible = visible;
        if (this.skeletonHelper) this.skeletonHelper.visible = visible && !this._multiCharacterSelection && !this._noCharacterSelection;
        if (this.jointMarkers) this.jointMarkers.forEach(marker => { marker.visible = visible && this._shouldMarkerBeVisible(marker); });
        if (this.transform) this.transform.visible = visible && !this._multiCharacterSelection && !this._noCharacterSelection && !!this.transform.object;
        if (!visible) {
            this._rotationGuideActive = false;
            this._rotationGuideHovered = false;
            this._rotationGuideFrame = null;
            if (this._rotationGuideSvg) this._rotationGuideSvg.style.display = "none";
            for (const ring of this._handRings || []) ring.visible = false;
        }
        this.requestRender();
    }

    saveRTMWCameraState() {
        if (!this.camera || !this.orbit) return;
        this._rtmwSavedCamera = {
            position: this.camera.position.clone(),
            quaternion: this.camera.quaternion.clone(),
            target: this.orbit.target.clone(),
            fov: this.camera.fov,
        };
    }

    restoreRTMWCameraState() {
        if (!this._rtmwSavedCamera) return false;
        this.camera.position.copy(this._rtmwSavedCamera.position);
        this.camera.quaternion.copy(this._rtmwSavedCamera.quaternion);
        this.orbit.target.copy(this._rtmwSavedCamera.target);
        this.camera.fov = this._rtmwSavedCamera.fov;
        this.camera.updateProjectionMatrix();
        this.orbit.update();
        this.requestRender();
        this.dispatchPoseChange();
        return true;
    }

    setRTMWFigureCameraParented(parented) {
        this._rtmwCameraParented = parented;
        if (!this._rtmwFigureGroup) return;
        if (parented) {
            this.camera.attach(this._rtmwFigureGroup);
        } else {
            this.scene.attach(this._rtmwFigureGroup);
        }
        this.requestRender();
    }

    setKpFigureVisible(visible) {
        this.importedFigureVisible = !!visible;
        if (this._kpFigureGroup) {
            this._kpFigureGroup.visible = visible;
            this.requestRender();
        }
        if (this._rtmwFigureGroup) {
            this._rtmwFigureGroup.visible = visible;
            this.requestRender();
        }
        if (this._hmr2FigureGroup) {
            this._hmr2FigureGroup.visible = visible;
            this.requestRender();
        }
        if (this._hmr2CanvasGroup) {
            this._hmr2CanvasGroup.visible = visible;
            this.requestRender();
        }
    }

    moveBoneToPosition(boneName, x, y, z) {
        const bone = this.boneList.find(item => item.name === boneName);
        if (!bone) {
            return false;
        }

        const worldPos = new this.THREE.Vector3(x, y, z);
        if (bone.parent) {
            const parentWorldInv = new this.THREE.Matrix4().copy(bone.parent.matrixWorld).invert();
            worldPos.applyMatrix4(parentWorldInv);
        }

        bone.position.copy(worldPos);
        bone.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();
        this.updateMarkers();
        this.requestRender();
        return true;
    }

    _findRTMWJointMesh(kpName) {
        if (!this._rtmwFigureGroup) return null;
        let found = null;
        this._rtmwFigureGroup.traverse((obj) => {
            if (!found && obj.userData.isRTMWJoint && typeof this._getRTMWKpName === 'function' && this._getRTMWKpName(obj.userData.rtmwKpIndex) === kpName) {
                found = obj;
            }
        });
        return found;
    }

    getRTMWJointWorldPos(kpName) {
        const mesh = this._findRTMWJointMesh(kpName);
        if (!mesh) return null;
        const worldPos = new this.THREE.Vector3();
        mesh.getWorldPosition(worldPos);
        return worldPos;
    }

    moveRTMWJoint(kpName, x, y, z) {
        const mesh = this._findRTMWJointMesh(kpName);
        if (!mesh) return false;
        const worldPos = new this.THREE.Vector3(x, y, z);
        if (mesh.parent) {
            const parentWorldInv = new this.THREE.Matrix4().copy(mesh.parent.matrixWorld).invert();
            worldPos.applyMatrix4(parentWorldInv);
        }
        mesh.position.copy(worldPos);
        this.requestRender();
        return true;
    }
}


// === Pose Studio Widget ===


export { IK_CHAINS };
