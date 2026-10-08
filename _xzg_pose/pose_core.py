"""Portable OpenPose sequence operations. Standard library only; no ComfyUI imports."""
import copy
import hashlib
import json
import math

GROUPS = ('pose_keypoints_2d', 'face_keypoints_2d', 'hand_left_keypoints_2d',
          'hand_right_keypoints_2d', 'foot_keypoints_2d')
SCALE_KEYS = ('head_x', 'head_y', 'neck', 'shoulders', 'upper_arm', 'lower_arm',
              'torso', 'hips', 'upper_leg', 'lower_leg', 'hands', 'feet')


def validate_frames(frames):
    if not isinstance(frames, list) or not frames:
        raise ValueError('POSE_KEYPOINT 必须是非空帧数组')
    for frame in frames:
        for key in ('canvas_width', 'canvas_height'):
            if not isinstance(frame.get(key), (int, float)) or not math.isfinite(frame[key]) or frame[key] <= 0:
                raise ValueError('画面尺寸必须为正数')
        if not isinstance(frame.get('people'), list):
            raise ValueError('每帧必须包含 people 数组')
        for person in frame['people']:
            if len(person.get('pose_keypoints_2d', [])) != 54:
                raise ValueError('需要 SDPOSE 的 OpenPose 18 身体关节格式')
            for key in GROUPS:
                values = person.get(key, [])
                if not isinstance(values, list) or len(values) % 3 or any(
                    not isinstance(v, (int, float)) or not math.isfinite(v) for v in values
                ):
                    raise ValueError(f'{key} 必须是有限数值的 x/y/score 三元组')
    return frames


def digest(frames):
    return hashlib.sha256(json.dumps(frames, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def validate_edits(edits, count, source_digest=None):
    if not isinstance(edits, dict) or edits.get('version') != 1:
        raise ValueError('编辑项目版本必须为 1')
    if edits.get('source_digest') and source_digest and edits['source_digest'] != source_digest:
        raise ValueError('骨骼源数据已改变，请重新打开编辑器并清除旧编辑')
    operations = edits.get('operations', [])
    if not isinstance(operations, list) or len(operations) > 10000:
        raise ValueError('编辑操作数量无效')
    hand_fixes = edits.get('hand_fixes', [{'type': 'swap_hands', 'person': -1}])
    if not isinstance(hand_fixes, list) or len(hand_fixes) > 10000:
        raise ValueError('全片手部修正数量无效')
    for op in operations + hand_fixes:
        if not isinstance(op, dict) or op.get('type') not in ('scale', 'translate', 'joint', 'set_joint', 'swap_hands', 'swap_arms', 'repair_hands', 'complete_pose'):
            raise ValueError('未知编辑操作')
        if op in hand_fixes and op.get('type') not in ('swap_hands', 'swap_arms', 'repair_hands'):
            raise ValueError('全片手部修正类型无效')
        person = op.get('person', -1)
        frame = op.get('frame')
        if type(person) is not int or person < -1:
            raise ValueError('人物索引无效')
        if frame is not None:
            if type(frame) is not int or not 0 <= frame < count:
                raise ValueError('关键帧索引无效')
        else:
            start, end = op.get('start', 0), op.get('end', count - 1)
            if any(type(v) is not int for v in (start, end)) or not 0 <= start <= end < count:
                raise ValueError('操作帧范围无效')
        if op['type'] == 'scale':
            values = op.get('values', {})
            if not isinstance(values, dict) or any(k not in SCALE_KEYS or not isinstance(v, (int, float))
                                                   or not math.isfinite(v) or not .1 <= v <= 3
                                                   for k, v in values.items()):
                raise ValueError('比例值范围为 0.1–3')
        elif op['type'] in ('translate', 'joint'):
            if any(not isinstance(op.get(k), (int, float)) or not math.isfinite(op[k]) or abs(op[k]) > 10
                   for k in ('dx', 'dy')):
                raise ValueError('位移必须是有限归一化数值')
        if op['type'] in ('joint', 'set_joint') and (type(op.get('joint')) is not int or not 0 <= op['joint'] < 18):
            raise ValueError('身体关节索引必须为 0–17')
        if op['type'] == 'set_joint' and any(not isinstance(op.get(k), (int, float)) or not math.isfinite(op[k]) or abs(op[k]) > 10 for k in ('x', 'y')):
            raise ValueError('补画关节坐标必须为有限归一化数值')
        if op['type'] == 'set_joint' and 'deleted' in op and type(op['deleted']) is not bool:
            raise ValueError('关节删除状态必须为布尔值')
    return edits


def _point(flat, index):
    return flat[index * 3:index * 3 + 2]


def _set(flat, index, point):
    flat[index * 3:index * 3 + 2] = point


def _move_group(flat, dx, dy, sx=1, sy=1, anchor=(0, 0)):
    for i in range(0, len(flat), 3):
        if flat[i + 2] <= 0:
            continue
        flat[i] = anchor[0] + (flat[i] - anchor[0]) * sx + dx
        flat[i + 1] = anchor[1] + (flat[i + 1] - anchor[1]) * sy + dy


def transform_person(person, values):
    s = {k: values.get(k, 1) for k in SCALE_KEYS}
    body = person['pose_keypoints_2d']
    old = [_point(body, i) for i in range(18)]
    new = copy.deepcopy(old)
    mid = lambda a, b: [(a[i] + b[i]) / 2 for i in (0, 1)]
    shoulder, hip = mid(old[2], old[5]), mid(old[8], old[11])
    head_anchor = old[0]
    neck_vector = [old[0][i] - old[1][i] for i in (0, 1)]
    moved_head_anchor = [old[1][i] + neck_vector[i] * s['neck'] for i in (0, 1)]
    head_delta = [moved_head_anchor[i] - head_anchor[i] for i in (0, 1)]
    new[0] = moved_head_anchor
    for j in (14, 15, 16, 17):
        new[j] = [moved_head_anchor[i] + (old[j][i] - head_anchor[i]) * s['head_x' if i == 0 else 'head_y'] for i in (0, 1)]
    for j in (2, 5):
        new[j] = [shoulder[i] + (old[j][i] - shoulder[i]) * s['shoulders'] for i in (0, 1)]
    target_hip = [shoulder[i] + (hip[i] - shoulder[i]) * s['torso'] for i in (0, 1)]
    for j in (8, 11):
        new[j] = [target_hip[i] + (old[j][i] - hip[i]) * s['hips'] for i in (0, 1)]
    for parent, child, key in ((2, 3, 'upper_arm'), (3, 4, 'lower_arm'), (5, 6, 'upper_arm'),
                               (6, 7, 'lower_arm'), (8, 9, 'upper_leg'), (9, 10, 'lower_leg'),
                               (11, 12, 'upper_leg'), (12, 13, 'lower_leg')):
        new[child] = [new[parent][i] + (old[child][i] - old[parent][i]) * s[key] for i in (0, 1)]
    _move_group(person.get('face_keypoints_2d', []), head_delta[0],
                head_delta[1], s['head_x'], s['head_y'], head_anchor)
    for key, joint in (('hand_right_keypoints_2d', 4), ('hand_left_keypoints_2d', 7)):
        _move_group(person.get(key, []), new[joint][0] - old[joint][0], new[joint][1] - old[joint][1],
                    s['hands'], s['hands'], old[joint])
    feet = person.get('foot_keypoints_2d', [])
    for offset, joint in ((0, 13), (9, 10)):
        part = feet[offset:offset + 9]
        _move_group(part, new[joint][0] - old[joint][0], new[joint][1] - old[joint][1],
                    s['feet'], s['feet'], old[joint])
        feet[offset:offset + len(part)] = part
    for j in range(18):
        if body[j * 3 + 2] > 0:
            _set(body, j, new[j])


def swap_hands(person):
    left = 'hand_left_keypoints_2d'
    right = 'hand_right_keypoints_2d'
    left_value, right_value = person.pop(left, None), person.pop(right, None)
    if right_value is not None:
        person[left] = right_value
    if left_value is not None:
        person[right] = left_value


def repair_hands(person, width, height):
    body = person['pose_keypoints_2d']
    left = person.get('hand_left_keypoints_2d', [])
    right = person.get('hand_right_keypoints_2d', [])
    if len(left) < 3 or len(right) < 3 or min(left[2], right[2], body[14], body[23]) <= .05:
        return False
    lw, rw = _point(body, 7), _point(body, 4)
    diagonal = math.hypot(width, height)
    left_weight, right_weight = max(.15, left[2]), max(.15, right[2])
    same = (math.dist(left[:2], lw) * left_weight + math.dist(right[:2], rw) * right_weight) / (left_weight + right_weight)
    swapped = (math.dist(left[:2], rw) * left_weight + math.dist(right[:2], lw) * right_weight) / (left_weight + right_weight)
    if same - swapped > max(3, .005 * diagonal) and swapped < .9 * same:
        swap_hands(person)
        return True
    return False


def apply_edits(frames, edits, source_digest=None):
    validate_frames(frames)
    validate_edits(edits, len(frames), source_digest)
    result = copy.deepcopy(frames)
    operations = [op for op in edits.get('operations', [])
                  if op['type'] not in ('complete_pose', 'swap_hands', 'repair_hands')]
    hand_fixes = [op for op in edits.get('hand_fixes', [])
                  if op['type'] not in ('swap_hands', 'repair_hands')]
    hand_fixes.append({'type': 'swap_hands', 'person': -1})
    continuous = {}
    discrete = {}
    legacy = []
    for op in hand_fixes + operations:
        if 'frame' not in op:
            legacy.append(op)
        elif op['type'] in ('scale', 'translate', 'joint', 'set_joint'):
            key = (op['type'], op.get('person', -1), op.get('joint') if op['type'] in ('joint', 'set_joint') else None)
            continuous.setdefault(key, []).append(op)
        else:
            discrete.setdefault((op['type'], op.get('person', -1)), []).append(op)
    for keys in continuous.values():
        keys.sort(key=lambda op: op['frame'])
    for events in discrete.values():
        events.sort(key=lambda op: op['frame'])

    for frame_index, frame in enumerate(result):
        frame_ops = list(legacy)
        for keys in continuous.values():
            left = keys[0]
            right = keys[-1]
            if frame_index <= left['frame']:
                right = left
            elif frame_index >= right['frame']:
                left = right
            else:
                for i in range(1, len(keys)):
                    if keys[i]['frame'] >= frame_index:
                        left, right = keys[i - 1], keys[i]
                        break
            t = 0 if left is right else (frame_index - left['frame']) / (right['frame'] - left['frame'])
            sampled = dict(left)
            if left['type'] == 'scale':
                sampled['values'] = {key: left.get('values', {}).get(key, 1) +
                                     (right.get('values', {}).get(key, 1) - left.get('values', {}).get(key, 1)) * t
                                     for key in SCALE_KEYS}
            elif left['type'] == 'set_joint':
                sampled['x'] = left['x'] + (right['x'] - left['x']) * t
                sampled['y'] = left['y'] + (right['y'] - left['y']) * t
                sampled['deleted'] = (right if t == 1 else left).get('deleted', False)
            else:
                sampled['dx'] = left.get('dx', 0) + (right.get('dx', 0) - left.get('dx', 0)) * t
                sampled['dy'] = left.get('dy', 0) + (right.get('dy', 0) - left.get('dy', 0)) * t
            frame_ops.append(sampled)
        for events in discrete.values():
            if events[0]['type'] in ('swap_hands', 'swap_arms'):
                toggles = sum(1 for event in events[1:] if event['frame'] <= frame_index)
                if toggles % 2:
                    continue
                frame_ops.append(events[0])
            else:
                chosen = next((op for op in reversed(events) if op['frame'] <= frame_index), events[0])
                frame_ops.append(chosen)
        for op in frame_ops:
            if 'frame' in op:
                pass
            elif not op.get('start', 0) <= frame_index <= op.get('end', len(result) - 1):
                continue
            person_index = op.get('person', -1)
            people = frame['people'] if person_index == -1 else frame['people'][person_index:person_index + 1]
            for person in people:
                if op['type'] == 'scale':
                    transform_person(person, op.get('values', {}))
                elif op['type'] in ('swap_hands', 'swap_arms'):
                    if op['type'] == 'swap_arms':
                        body = person['pose_keypoints_2d']
                        for a, b in ((2, 5), (3, 6), (4, 7)):
                            pa, pb = body[a*3:a*3+3], body[b*3:b*3+3]
                            body[a*3:a*3+3], body[b*3:b*3+3] = pb, pa
                    swap_hands(person)
                elif op['type'] == 'repair_hands':
                    repair_hands(person, frame['canvas_width'], frame['canvas_height'])
                elif op['type'] == 'set_joint':
                    body = person['pose_keypoints_2d']
                    joint = op['joint']
                    body[joint * 3:joint * 3 + 3] = [op['x'] * frame['canvas_width'], op['y'] * frame['canvas_height'], 0 if op.get('deleted', False) else .8]
                else:
                    dx, dy = op['dx'] * frame['canvas_width'], op['dy'] * frame['canvas_height']
                    if op['type'] == 'translate':
                        for group in GROUPS:
                            _move_group(person.get(group, []), dx, dy)
                    else:
                        joint = op['joint']
                        body = person['pose_keypoints_2d']
                        point = _point(body, joint)
                        _set(body, joint, [point[0] + dx, point[1] + dy])
                        attached = {4: 'hand_right_keypoints_2d', 7: 'hand_left_keypoints_2d'}.get(joint)
                        if attached:
                            _move_group(person.get(attached, []), dx, dy)
                        if joint in (0, 1):
                            for head_joint in (0, 14, 15, 16, 17):
                                if head_joint == joint or body[head_joint * 3 + 2] <= 0:
                                    continue
                                head_point = _point(body, head_joint)
                                _set(body, head_joint, [head_point[0] + dx, head_point[1] + dy])
                            _move_group(person.get('face_keypoints_2d', []), dx, dy)
                        if joint in (10, 13):
                            feet = person.get('foot_keypoints_2d', [])
                            start = 9 if joint == 10 else 0
                            part = feet[start:start + 9]
                            _move_group(part, dx, dy)
                            feet[start:start + len(part)] = part
    return result
