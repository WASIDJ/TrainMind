// Each pack defines the photography and crop for its three placements.
// This manifest is independent of the training plan and session data.
const packData = [
  {
    id: 'lin', name: '林澄', caption: '力量教练 · 冷蓝纪实', photo: '../hero-a.jpg',
    avatar: { zoom: 2.9, x: -142, y: 0 },
    cover: 'center 28%', portrait: 'center 8%'
  },
  {
    id: 'yue', name: '岳川', caption: '力量教练 · 深夜馆', photo: './coach-yue.jpg',
    avatar: { zoom: 3, x: -91, y: 0 },
    cover: 'center 26%', portrait: 'center 10%'
  },
  {
    id: 'su', name: '苏禾', caption: '力量教练 · 自然光', photo: '../hero-b.jpg',
    avatar: { zoom: 3.7, x: -168, y: -63 },
    cover: 'center 34%', portrait: 'center 20%'
  }
];

export const packs = packData.map(pack => ({ ...pack, photo: new URL(pack.photo, import.meta.url).href }));
