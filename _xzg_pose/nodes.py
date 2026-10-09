import json
from .pose_core import apply_edits, digest, validate_frames
from . import session_store


class PoseSequenceEditor:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {
            'pose_keypoint': ('POSE_KEYPOINT',),
            'fps': ('FLOAT', {'default': 25.0, 'min': 1, 'max': 240, 'step': .01}),
            'edits_json': ('STRING', {'default': '{"version":1,"operations":[]}', 'multiline': True}),
            'draw_hands': ('BOOLEAN', {'default': True}),
            'draw_face': ('BOOLEAN', {'default': True}),
            'draw_feet': ('BOOLEAN', {'default': False}),
            'stick_width': ('INT', {'default': 4, 'min': 1, 'max': 10, 'step': 1}),
            'face_point_size': ('INT', {'default': 3, 'min': 1, 'max': 10, 'step': 1}),
            'score_threshold': ('FLOAT', {'default': .3, 'min': 0.0, 'max': 1.0, 'step': .01}),
        }, 'optional': {'images': ('IMAGE',)}, 'hidden': {'unique_id': 'UNIQUE_ID'}}

    RETURN_TYPES = ('IMAGE',)
    RETURN_NAMES = ('image',)
    FUNCTION = 'execute'
    CATEGORY = '小珠光/视频'
    # Do not force-run this node as a graph output. Downstream lazy switches
    # must be able to skip its session creation and image rendering entirely.
    OUTPUT_NODE = False
    DESCRIPTION = '执行一次加载骨骼序列，打开可视化编辑器保存调整，再执行输出修改后的骨骼。'

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Refresh an expired process-local preview without re-running upstream SDPOSE.
        return float('nan')

    def execute(self, pose_keypoint, fps=25.0, edits_json='{"version":1,"operations":[]}',
                draw_hands=True, draw_face=True, draw_feet=False,
                stick_width=4, face_point_size=3, score_threshold=.3,
                images=None, unique_id=None):
        validate_frames(pose_keypoint)
        source_digest = digest(pose_keypoint)
        edits = json.loads(edits_json)
        edited = apply_edits(pose_keypoint, edits, source_digest)
        if images is not None and len(images) not in (1, len(pose_keypoint)):
            raise ValueError('预览图像帧数必须等于骨骼帧数，或为单张参考图')
        token = session_store.put(pose_keypoint, images, fps, source_digest)
        pose_images = self._render_images(
            edited, draw_hands, draw_face, draw_feet,
            stick_width, face_point_size, score_threshold,
        )
        return {'ui': {'pose_session': [token], 'frame_count': [len(edited)]},
                'result': (pose_images,)}

    @staticmethod
    def _render_images(frames, draw_hands, draw_face, draw_feet,
                       stick_width, face_point_size, score_threshold):
        import numpy as np
        import torch
        import comfy.model_management
        from comfy_extras.pose.keypoint_draw import KeypointDraw

        if not frames:
            return torch.zeros((1, 64, 64, 3), dtype=torch.float32)

        height, width = int(frames[0]['canvas_height']), int(frames[0]['canvas_width'])

        def parse_points(person, name, count):
            values = person.get(name) or []
            points = np.zeros((count, 3), dtype=np.float32)
            available = min(count, len(values) // 3)
            if available:
                points[:available] = np.asarray(values[:available * 3], dtype=np.float32).reshape(available, 3)
            return points[:, :2], points[:, 2]

        drawer = KeypointDraw()
        rendered = []
        for frame in frames:
            canvas = np.zeros((height, width, 3), dtype=np.uint8)
            for person in frame['people']:
                body, body_scores = parse_points(person, 'pose_keypoints_2d', 18)
                feet, foot_scores = parse_points(person, 'foot_keypoints_2d', 6)
                face, face_scores = parse_points(person, 'face_keypoints_2d', 70)
                right_hand, right_hand_scores = parse_points(person, 'hand_right_keypoints_2d', 21)
                left_hand, left_hand_scores = parse_points(person, 'hand_left_keypoints_2d', 21)
                keypoints = np.concatenate((body, feet, face[:68], right_hand, left_hand), axis=0)
                scores = np.concatenate((body_scores, foot_scores, face_scores[:68], right_hand_scores, left_hand_scores), axis=0)
                canvas = drawer.draw_wholebody_keypoints(
                    canvas, keypoints, scores,
                    threshold=score_threshold,
                    draw_body=True, draw_head=True, draw_feet=draw_feet,
                    draw_face=draw_face, draw_hands=draw_hands,
                    stick_width=stick_width, face_point_size=face_point_size,
                )
            rendered.append(canvas)

        image_batch = np.stack(rendered) if len(rendered) > 1 else np.expand_dims(rendered[0], 0)
        return torch.from_numpy(image_batch).to(
            device=comfy.model_management.intermediate_device(),
            dtype=comfy.model_management.intermediate_dtype(),
        ) / 255.0



NODE_CLASS_MAPPINGS = {'ComfyUIPoseSequenceEditor': PoseSequenceEditor}
NODE_DISPLAY_NAME_MAPPINGS = {'ComfyUIPoseSequenceEditor': '\u5c0f\u73e0\u5149\u89c6\u9891\u59ff\u52bf\u7f16\u8f91\u5668'}
