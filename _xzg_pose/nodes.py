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
        }, 'optional': {'images': ('IMAGE',)}, 'hidden': {'unique_id': 'UNIQUE_ID'}}

    RETURN_TYPES = ('POSE_KEYPOINT',)
    RETURN_NAMES = ('pose_keypoint',)
    FUNCTION = 'execute'
    CATEGORY = 'xiaozhuguang'
    OUTPUT_NODE = True
    DESCRIPTION = '执行一次加载骨骼序列，打开可视化编辑器保存调整，再执行输出修改后的骨骼。'

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Refresh an expired process-local preview without re-running upstream SDPOSE.
        return float('nan')

    def execute(self, pose_keypoint, fps=25.0, edits_json='{"version":1,"operations":[]}', images=None, unique_id=None):
        validate_frames(pose_keypoint)
        source_digest = digest(pose_keypoint)
        edits = json.loads(edits_json)
        edited = apply_edits(pose_keypoint, edits, source_digest)
        if images is not None and len(images) not in (1, len(pose_keypoint)):
            raise ValueError('预览图像帧数必须等于骨骼帧数，或为单张参考图')
        token = session_store.put(pose_keypoint, images, fps, source_digest)
        return {'ui': {'pose_session': [token], 'frame_count': [len(edited)]},
                'result': (edited,)}



NODE_CLASS_MAPPINGS = {'ComfyUIPoseSequenceEditor': PoseSequenceEditor}
NODE_DISPLAY_NAME_MAPPINGS = {'ComfyUIPoseSequenceEditor': '\u5c0f\u73e0\u5149\u89c6\u9891\u59ff\u52bf\u7f16\u8f91\u5668'}
