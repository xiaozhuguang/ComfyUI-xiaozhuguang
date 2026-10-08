import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pose_core', ROOT / 'pose_core.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def fixture():
    points = [(320, 90), (320, 140), (270, 140), (240, 205), (210, 265),
              (370, 140), (400, 205), (430, 265), (290, 265), (280, 345),
              (270, 420), (350, 265), (360, 345), (370, 420),
              (310, 80), (330, 80), (300, 90), (340, 90)]
    person = {'pose_keypoints_2d': [v for x,y in points for v in (x,y,.9)],
              'face_keypoints_2d': [320,100,.8,0,0,0],
              'hand_right_keypoints_2d': [210,265,.8,215,270,.7],
              'hand_left_keypoints_2d': [430,265,.8],
              'foot_keypoints_2d': [370,420,.8,380,420,.8,370,425,.8,
                                    270,420,.8,280,420,.8,270,425,.8],
              'tracking_hint': 'preserve-extra-fields'}
    return [{'canvas_width':640,'canvas_height':480,'people':[copy.deepcopy(person),copy.deepcopy(person)]}
            for _ in range(5)]


class CoreTests(unittest.TestCase):
    def test_identity_and_no_mutation(self):
        frames=fixture(); before=copy.deepcopy(frames)
        result=core.apply_edits(frames,{'version':1,'operations':[{'type':'scale','values':{}}]})
        self.assertEqual(result,before); self.assertEqual(frames,before)
        result[0]['people'][0]['pose_keypoints_2d'][0]=1
        self.assertEqual(frames,before)

    def test_range_person_and_hand_anchor(self):
        frames=fixture(); op={'type':'scale','start':1,'end':3,'person':0,'values':{'shoulders':1.5}}
        result=core.apply_edits(frames,{'version':1,'operations':[op]})
        self.assertEqual(result[0],frames[0]); self.assertEqual(result[4],frames[4])
        self.assertEqual(result[2]['people'][1],frames[2]['people'][1])
        p=result[2]['people'][0]; body=p['pose_keypoints_2d']
        self.assertEqual(body[6],245); self.assertEqual(body[15],395)
        self.assertEqual(body[12],185)
        self.assertEqual(p['hand_right_keypoints_2d'][0],185)
        self.assertEqual(p['hand_right_keypoints_2d'][3],190)
        self.assertEqual(p['tracking_hint'],'preserve-extra-fields')

    def test_joint_batch_keeps_all_frame_motion(self):
        frames=fixture(); frames[2]['people'][0]['pose_keypoints_2d'][12]+=15
        result=core.apply_edits(frames,{'version':1,'operations':[{'type':'joint','joint':4,
             'start':0,'end':4,'person':0,'dx':.1,'dy':-.05}]})
        for i in range(5):
            self.assertAlmostEqual(result[i]['people'][0]['pose_keypoints_2d'][12],
                                   frames[i]['people'][0]['pose_keypoints_2d'][12]+64)
        self.assertEqual(result[2]['people'][0]['hand_right_keypoints_2d'][:2],[274,241])

    def test_invalid_data_and_source_change(self):
        for op in ({'type':'scale','values':{'hips':float('nan')}},
                   {'type':'translate','dx':0,'dy':0,'end':7},
                   {'type':'joint','joint':18,'dx':0,'dy':0}):
            with self.assertRaises(ValueError): core.apply_edits(fixture(),{'version':1,'operations':[op]})
        with self.assertRaises(ValueError):
            core.apply_edits(fixture(),{'version':1,'source_digest':'different','operations':[]},core.digest(fixture()))

    def test_auto_hand_repair_and_idempotence(self):
        frames=fixture(); original=copy.deepcopy(frames)
        p=frames[2]['people'][0]
        p['hand_left_keypoints_2d'],p['hand_right_keypoints_2d']=p['hand_right_keypoints_2d'],p['hand_left_keypoints_2d']
        op={'type':'repair_hands','start':1,'end':3,'person':0}
        result=core.apply_edits(frames,{'version':1,'operations':[op]})
        self.assertEqual(result,original)
        self.assertEqual(core.apply_edits(result,{'version':1,'operations':[op]}),result)

    def test_repair_skips_low_confidence_and_overlapping_wrists(self):
        frames=fixture()
        for p in frames[0]['people']:
            p['hand_left_keypoints_2d'],p['hand_right_keypoints_2d']=p['hand_right_keypoints_2d'],p['hand_left_keypoints_2d']
        frames[0]['people'][0]['hand_left_keypoints_2d'][2]=.1
        b=frames[0]['people'][1]['pose_keypoints_2d']; b[21:24]=b[12:15]
        out=core.apply_edits(frames,{'version':1,'operations':[{'type':'repair_hands'}]})
        self.assertEqual(out,frames)

    def test_manual_arm_swap_preserves_confidence_and_range(self):
        frames=fixture();op={'type':'swap_arms','start':2,'end':2,'person':0}
        out=core.apply_edits(frames,{'version':1,'operations':[op]})
        self.assertEqual(out[1],frames[1]);self.assertEqual(out[2]['people'][1],frames[2]['people'][1])
        self.assertEqual(out[2]['people'][0]['pose_keypoints_2d'][6:9],frames[2]['people'][0]['pose_keypoints_2d'][15:18])
        self.assertEqual(core.apply_edits(out,{'version':1,'operations':[op]}),frames)

    def test_empty_people_and_zero_confidence(self):
        frames=fixture();frames[0]['people']=[]
        out=core.apply_edits(frames,{'version':1,'operations':[{'type':'translate','dx':.1,'dy':.1}]})
        self.assertEqual(out[0]['people'],[])
        self.assertEqual(out[1]['people'][0]['face_keypoints_2d'][3:],[0,0,0])


if __name__=='__main__':
    unittest.main()
