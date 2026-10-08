import copy
import importlib.util
from pathlib import Path
import threading
import unittest

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location('video_tracking', Path(__file__).resolve().parents[1] / 'video_tracking.py')
tracking = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tracking)
core_spec = importlib.util.spec_from_file_location('tracking_pose_core', Path(__file__).resolve().parents[1] / 'pose_core.py')
core = importlib.util.module_from_spec(core_spec)
core_spec.loader.exec_module(core)


def fixture():
    base = np.random.default_rng(9).integers(0, 256, (160, 200, 3), dtype=np.uint8)
    images = np.stack([cv2.warpAffine(base, np.float32([[1, 0, i * 2], [0, 1, i]]),
                                    (200, 160)).astype(np.float32) / 255 for i in range(9)])
    data = {'images': images, 'frames': [{'people': [{}]} for _ in images], 'source_digest': 'test'}
    payload = {'source_digest': 'test', 'start': 0, 'end': 8, 'person': 0, 'joint': 13,
               'anchors': [{'frame': 0, 'x': .4, 'y': .5}, {'frame': 8, 'x': .48, 'y': .55}]}
    return data, payload


class VideoTrackingTests(unittest.TestCase):
    def test_bidirectional_translation(self):
        data, payload = fixture()
        updates = []
        result = tracking.track_joint(data, payload, progress=lambda done, total: updates.append((done, total)))
        self.assertEqual(result['failed_frames'], [])
        self.assertEqual(len(result['points']), 7)
        for point in result['points']:
            self.assertAlmostEqual(point['x'], .4 + .01 * point['frame'], delta=.005)
            self.assertAlmostEqual(point['y'], .5 + point['frame'] / 160, delta=.005)
        self.assertEqual(updates[-1], (16, 16))

    def test_textureless_frames_are_not_invented(self):
        data, payload = fixture()
        data['images'][:] = .5
        result = tracking.track_joint(data, payload)
        self.assertEqual(result['points'], [])
        self.assertEqual(result['failed_frames'], list(range(1, 8)))

    def test_tracking_requires_exactly_two_manual_anchors(self):
        data, payload = fixture()
        payload['anchors'].insert(1, {'frame': 4, 'x': .44, 'y': .525})
        with self.assertRaisesRegex(ValueError, '两个绿色'):
            tracking.track_joint(data, payload)

    def test_incompatible_endpoint_rejects_drift(self):
        data, payload = fixture()
        payload['anchors'][-1]['x'] = .8
        result = tracking.track_joint(data, payload)
        self.assertGreater(len(result['failed_frames']), 0)
        self.assertLess(len(result['points']), 7)

    def test_cancel_stops_work(self):
        data, payload = fixture()
        event = threading.Event()
        def progress(done, total):
            event.set()
        with self.assertRaises(InterruptedError):
            tracking.track_joint(data, payload, event, progress)

    def test_saved_tracking_keys_replay_without_video_session(self):
        data, payload = fixture()
        result = tracking.track_joint(data, payload)
        body = [0.0] * 54
        body[39:42] = [80, 80, .8]
        frames = [{'canvas_width': 200, 'canvas_height': 160,
                   'people': [{'pose_keypoints_2d': body.copy()}]} for _ in range(9)]
        positions = payload['anchors'] + result['points']
        operations = [{'type': 'set_joint', 'person': 0, 'joint': 13,
                       'frame': p['frame'], 'x': p['x'], 'y': p['y'],
                       'active_ranges': [[0, 8]], 'needs_adjustment': p['frame'] not in (0, 8),
                       'completion_source': 'video', 'tracking_confidence': p.get('confidence', 1)}
                      for p in positions]
        edited = core.apply_edits(frames, {'version': 1, 'operations': operations})
        for index, frame in enumerate(edited):
            self.assertAlmostEqual(frame['people'][0]['pose_keypoints_2d'][39], 80 + index * 2, delta=1)
            self.assertAlmostEqual(frame['people'][0]['pose_keypoints_2d'][40], 80 + index, delta=1)

    def test_rejects_bad_inputs(self):
        data, payload = fixture()
        for mutate in [lambda d, p: d.update(images=None),
                       lambda d, p: d.update(images=d['images'][:1]),
                       lambda d, p: p.update(source_digest='stale'),
                       lambda d, p: p.update(joint=True),
                       lambda d, p: p['anchors'][0].update(x=float('nan')),
                       lambda d, p: p['anchors'][0].update(frame=1),
                       lambda d, p: p['anchors'].reverse()]:
            with self.subTest(mutate=mutate):
                changed, request = copy.deepcopy(data), copy.deepcopy(payload)
                mutate(changed, request)
                with self.assertRaises(ValueError):
                    tracking.validate_request(changed, request)

    def test_adjustment_tracking_restores_missing_joint_and_moves_attached_hand(self):
        frames = [{'canvas_width': 100, 'canvas_height': 100, 'people': [{
            'pose_keypoints_2d': [0.0] * 54,
            'hand_left_keypoints_2d': [10, 20, .9],
            'hand_right_keypoints_2d': []}]} for _ in range(3)]
        operations = [{'type': 'joint', 'person': 0, 'joint': 4, 'frame': 1,
                       'dx': .4, 'dy': .5, 'ensure_joint': True,
                       'active_ranges': [[1, 1]], 'completion_source': 'video',
                       'needs_adjustment': True}]
        edited = core.apply_edits(frames, {'version': 1, 'operations': operations})
        self.assertEqual(edited[1]['people'][0]['pose_keypoints_2d'][12:15], [40, 50, .8])
        self.assertEqual(edited[1]['people'][0]['hand_right_keypoints_2d'], [50, 70, .9])
        self.assertEqual(edited[0]['people'][0]['pose_keypoints_2d'], frames[0]['people'][0]['pose_keypoints_2d'])
        self.assertEqual(edited[2]['people'][0]['pose_keypoints_2d'], frames[2]['people'][0]['pose_keypoints_2d'])


if __name__ == '__main__':
    unittest.main()
