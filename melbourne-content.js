// Melbourne edition visitor-facing content.
// The review-stage public title is imported from config.js so a later title
// decision changes in one place. Other Melbourne copy lives here.

import { PUBLIC_TITLE } from './config.js?v=melbourne-access-v10-20260930';

export const MELBOURNE = {
  edition: 'melbourne-2026',
  title: PUBLIC_TITLE,
  publicTitle: PUBLIC_TITLE,
  titleUpper: PUBLIC_TITLE.toUpperCase(),
  artist: 'Minnie Park · 박지민',
  artistCredit: 'BY MINNIE · JIMIN PARK · 박지민',
  festival: 'MELBOURNE FRINGE FESTIVAL 2026',
  city: 'Melbourne',
  year: '2026',
  cityYear: 'MELBOURNE / 2026',
  venue: 'The Mission to Seafarers Victoria',
  address: '717 Flinders Street, Docklands VIC 3008',
  timeZone: 'Australia/Melbourne',
  accessCredit: 'This project has been made more accessible with support from Access Fringe.',
};

export const ABOUT_SECTIONS = [
  {
    id: 'about-intro', index: '01',
    titleKo: '작품이 시작된 질문', titleEn: 'THE QUESTION THAT BEGAN THE WORK',
    leadKo: '타인에게는 너그러우면서 왜 자기 자신에게는 그렇게 잔인해질까요.',
    leadEn: 'Why can we be generous to others and still be so cruel to ourselves?',
    bodyKo: [
      '우리는 사랑하는 사람의 결함을 그 사람의 일부로 받아들이면서도, 자기 안에서 같은 결함을 발견하면 없애야 할 것으로 취급하곤 합니다. 게으른 나, 우울한 나, 실패한 나, 질투하는 나, 겁이 많은 나. 살아 있는 한 사람 안에 머물 수 있는 여러 얼굴을 스스로 쫓아내고 죽입니다.',
      '이 프로젝트는 그렇게 죽여 온 ‘나’를 위한 장례식에서 시작합니다. 그러나 완전히 보내버리기 위한 의식은 아닙니다. 죽였다고 믿은 것이 어떤 모습으로 돌아오는지 보고, 그 존재와의 관계를 다시 선택하는 자리입니다.',
    ],
    bodyEn: [
      'We may accept the flaws of someone we love, yet treat the same qualities in ourselves as things that must be removed: the frightened self, the jealous self, the self that failed, withdrew or could not keep up. A living person can contain all of these faces, but we repeatedly exile them from our own image.',
      'The project began as a funeral for those selves. It is not a ritual for making them disappear. It asks what returns after we believe something has been killed, and whether we can choose a different relationship with what remains.',
    ],
    deeperKo: [
      '죽인 사람과 죽은 사람, 그리고 장례 뒤에 남은 사람이 모두 나일 수 있습니다. 장례식이라는 형식은 끝을 선언하기 위해서가 아니라 평소에는 보이지 않던 관계를 잠시 드러내기 위해 사용됩니다.',
      '작품은 불편했던 나의 면이 사라졌다고 선언하지 않습니다. 그 면을 제거해야만 앞으로 갈 수 있다는 생각을 멈추고, 그 안에 함께 있었던 다른 얼굴까지 같은 시간에 놓아봅니다.',
    ],
    deeperEn: [
      'The person who killed, the person who died and the person left after the funeral may all be the same self. The funeral form does not declare a clean ending; it briefly makes this hidden relationship visible.',
      'The work never claims that an unwanted side has vanished. It suspends the demand to remove that side before moving forward and places its other, simultaneous faces beside it.',
    ],
  },
  {
    id: 'about-vanitas', index: '02',
    titleKo: '바니타스에서 가져온 것', titleEn: 'WHAT THE WORK TAKES FROM VANITAS',
    leadKo: '꽃, 해골, 썩는 과일과 꺼지는 빛은 삶이 유한하다는 사실을 한 화면에 놓아왔습니다.',
    leadEn: 'Flowers, skulls, decaying fruit and fading light have long shared one image of finite life.',
    bodyKo: [
      '바니타스 정물화에서 활짝 핀 꽃과 해골은 서로 반대되는 장식이 아닙니다. 가장 아름다운 순간 안에 이미 시듦이 있고, 죽음의 이미지 안에도 한때 살아 있던 시간의 흔적이 있습니다.',
      '이 작업은 “우리는 언젠가 죽는다”는 오래된 문장 옆에 “나는 살아 있는 동안 무엇을 계속 죽이고 있는가”라는 질문을 둡니다.',
    ],
    bodyEn: [
      'In a vanitas still life, a flower in bloom and a skull are not simply opposing decorations. Withering is already present inside the flower’s most beautiful moment, while the skull carries the time of a body that once lived.',
      'Beside the old reminder that we will die, this work places another question: what do I keep killing while I am alive?',
    ],
    deeperKo: [
      '여기의 장미와 죽음의 형상은 멀리서 바라보는 상징에 머물지 않습니다. 관객의 손과 몸을 기다리고, 접촉을 통해 빛과 소리를 얻으며, 살아 있음과 소멸을 같은 회로 안에서 보여줍니다.',
    ],
    deeperEn: [
      'The roses and figures of death are not symbols held at a distance. They wait for the audience body, gain light and sound through contact, and make life and disappearance occur within the same circuit.',
    ],
  },
  {
    id: 'about-rose', index: '03',
    titleKo: '장미가 가진 여러 얼굴', titleEn: 'THE MANY FACES OF THE ROSE',
    leadKo: '장미는 사랑의 꽃이면서 장례의 꽃이고, 피어난 얼굴과 가시를 한 몸에 가지고 있습니다.',
    leadEn: 'A rose belongs to love and mourning, carrying bloom and thorn in the same body.',
    bodyKo: [
      '장미 한 송이를 좋은 감정이나 나쁜 감정 하나에 고정하지 않습니다. 같은 성질이 어떤 순간에는 자신을 지키고, 다른 순간에는 자신과 타인을 찌를 수 있기 때문입니다.',
      '관객이 고른 색에도 미리 감정의 이름을 붙이지 않습니다. 색은 진단이 아니라 전시장 안에서 자신의 장면을 다시 찾기 위한 표식입니다.',
    ],
    bodyEn: [
      'No rose is fixed to one good or bad feeling. The same quality may protect us in one moment and wound ourselves or someone else in another.',
      'The colour chosen by a visitor is not assigned an emotion in advance. It is not a diagnosis; it is a marker that helps their images return to them across the exhibition.',
    ],
    deeperKo: [
      '생화는 살아 있어서 사라지고, 조화와 디지털 표본은 변하지 않도록 붙잡혀 오래 남습니다. 서로 다른 물성은 각 작품이 시간과 맺는 관계를 드러냅니다.',
    ],
    deeperEn: [
      'Living flowers disappear because they are alive. Artificial and digital specimens remain because change has been arrested. These different materials reveal the different relationships each work has with time.',
    ],
  },
  {
    id: 'about-ambivalence', index: '04',
    titleKo: '양가성과 동시성', titleEn: 'AMBIVALENCE AND SIMULTANEITY',
    leadKo: '미워한 면과 그것의 다른 얼굴을 동시에 바라볼 수 있을까요.',
    leadEn: 'Can an unwanted side and its other face be seen at the same time?',
    bodyKo: [
      '이 전시에서 살리는 행동과 죽이는 행동은 선과 악으로 깔끔하게 나뉘지 않습니다. 중요한 것은 어느 선택이 정답인가가 아니라, 무엇을 반복하고 언제 바꾸는가입니다.',
      '서로 모순되는 두 얼굴은 한쪽이 다른 쪽을 이기는 결말 없이 같은 이름과 같은 장면 안에 남을 수 있습니다.',
    ],
    bodyEn: [
      'Acts of care and acts of damage do not divide neatly into good and evil here. The question is not which control is correct, but what we repeat and when we choose to change.',
      'Two contradictory faces may remain in the same name and the same image without requiring one to defeat the other.',
    ],
    deeperKo: ['작품의 끝은 부정적인 면을 제거하고 긍정적인 면이 승리하는 장면이 아닙니다. 돌봄과 파괴, 상처와 다시 일어남은 서로를 취소하지 않습니다.'],
    deeperEn: ['The ending is not a victory in which a positive self removes a negative one. Care and damage, injury and return do not cancel each other out.'],
  },
  {
    id: 'about-choice', index: '05',
    titleKo: '선택을 관객에게 돌려주는 일', titleEn: 'RETURNING CHOICE TO THE AUDIENCE',
    leadKo: '작품은 관객의 감정을 대신 말하지 않으려 합니다.',
    leadEn: 'The work does not try to speak in place of the audience’s feelings.',
    bodyKo: [
      '무엇을 만질지, 얼마나 오래 볼지, 한 장면을 남길지, 언제 멈출지는 관객이 정합니다. 불편한 내용을 끝까지 견디는 것이 좋은 관람이라는 규칙도 없습니다.',
      '휴대폰 연결, 이름, 캡처와 설문 역시 선택입니다. 기술이 실패하거나 휴대폰을 사용하지 않는 경우, 각 작품에 현재 설치된 참여 방식을 스태프에게 확인할 수 있습니다.',
    ],
    bodyEn: [
      'Visitors decide what to touch, how long to stay, whether to keep an image and when to stop. Enduring discomfort is not a condition of proper participation.',
      'Phone connection, naming, capture and survey are optional. If technology fails or a visitor does not use a mobile phone, staff can confirm the participation method installed for each work.',
    ],
    deeperKo: ['선택권은 작품의 책임을 관객에게 떠넘기기 위한 말이 아닙니다. 죽음과 애도를 다루는 만큼 화면은 강요보다 예고를, 평가보다 되돌릴 수 있는 선택을 먼저 제공합니다.'],
    deeperEn: ['Choice does not transfer the work’s responsibility to the visitor. Because the work deals with death and mourning, it offers warning before pressure and reversible choices before evaluation.'],
  },
  {
    id: 'about-ritual', index: '06',
    titleKo: '네 개의 작품', titleEn: 'FOUR WORKS',
    leadKo: '명명하고, 개입하고, 목격하고, 기록합니다. 모든 단계를 완료할 필요는 없습니다.',
    leadEn: 'Name, intervene, witness and record. There is no requirement to complete every work.',
    bodyKo: [
      '01은 생화 장미와 관객의 몸이 회로가 되어 빛과 소리를 만듭니다. 02는 장미이자 스켈레톤인 형상에 개입하고, 03은 세계의 시간 속에서 왜곡된 자기 장미를 목격합니다.',
      '04는 완성된 작품 뒤에 사라지는 제작의 손과 실패, 반복의 시간을 소리 없는 영상으로 남깁니다.',
    ],
    bodyEn: [
      'In 01, living roses and audience bodies become a circuit for light and sound. In 02, visitors intervene in a figure that is both rose and skeleton. In 03, they witness a distorted rose within the time of the wider world.',
      '04 is a silent moving-image record of the hands, failures and repetitions that disappear behind the finished installation.',
    ],
    deeperKo: ['이 순서는 치료의 단계나 회복의 정답이 아닙니다. 한 작품만 보거나 순서를 바꾸거나 관람만 해도 완전한 참여입니다.'],
    deeperEn: ['This sequence is not a treatment plan or a correct path to recovery. Visiting one work, changing the order or simply observing are all complete forms of participation.'],
  },
  {
    id: 'about-work-01', index: '07',
    titleKo: '01 명명 / NAMING', titleEn: '01 NAMING',
    leadKo: '가까운 그라운드 로즈로 혼자 참여하거나, 여러 사람이 꽃과 서로를 연결해 빛과 소리를 만듭니다.',
    leadEn: 'Participate alone with a nearby ground rose, or connect flowers and people to make light and sound together.',
    bodyKo: ['각 장미는 서로 다른 빛과 소리를 가지고 있습니다. 오래 머물거나 장미와 사람의 조합을 바꾸며 오늘 가장 공명하는 순간을 찾습니다.'],
    bodyEn: ['Each rose carries a different light and sound. Stay, change the combination of flowers and people, and look for the moment that resonates most strongly today.'],
    deeperKo: ['꽃을 만지는 행동은 돌봄이면서 동시에 꽃의 시간을 앞당기는 접촉입니다. 가능한 조합 전체를 소유하는 대신, 몸이 실제로 반응하는 한순간의 균형을 찾습니다.'],
    deeperEn: ['Touching a flower is an act of care that also advances the flower’s time. Rather than possessing every possible combination, the visitor finds one temporary balance to which the body responds.'],
  },
  {
    id: 'about-work-02', index: '08',
    titleKo: '02 개입 / INTERVENTION', titleEn: '02 INTERVENTION',
    leadKo: '돌봄과 손상, 죽음과 다시 일어남이 한 몸에 함께 남는 과정에 직접 개입합니다.',
    leadEn: 'Intervene in a body where care and damage, death and return remain together.',
    bodyKo: ['엄지와 검지로 사각형을 만들면 카메라 마스크가 나타나고, 다섯 손가락을 펼치면 색과 이름을 가진 다른 마스크가 나타납니다.'],
    bodyEn: ['A rectangle formed with thumb and index finger reveals one camera mask. An open five-finger gesture reveals another mask carrying the visitor’s colour and optional name.'],
    deeperKo: ['기록하고 싶은 순간에는 로즈 휴먼 컨트롤러의 버튼 아무거나 두 개를 2초 동안 누릅니다. 눈을 감는 동작은 캡처 입력이 아닙니다.'],
    deeperEn: ['To request a capture, hold any two buttons on the Rose Human Controller for two seconds. Closing the eyes is not the capture input.'],
  },
  {
    id: 'about-work-03', index: '09',
    titleKo: '03 목격 / WITNESS', titleEn: '03 WITNESS',
    leadKo: '손으로 영상의 시간에 개입해 세계 속에 놓인 나의 장미 스켈레톤을 목격합니다.',
    leadEn: 'Use the hand to intervene in moving-image time and witness your rose-skeleton within the world.',
    bodyKo: ['손을 장미 가까이 두고 수직으로 움직여 영상의 속도를 조절합니다. 가장 느린 목격을 세 번 지나며 형체를 찾고, 찾았다고 느낄 때 장미 버튼을 누릅니다.'],
    bodyEn: ['Move a hand vertically near the rose to control the moving image. Pass through three slow acts of witness, then press the rose button when you feel you have found the figure.'],
    deeperKo: ['소리는 헤드폰이 아니라 공간의 스피커로 재생됩니다. 가만히 머물러 영상을 보는 시간 역시 작품이며, 손이 멈췄다는 이유만으로 관람이 종료되지 않습니다.'],
    deeperEn: ['Sound is played through room speakers, not headphones. Stillness and sustained looking are part of the work; the experience does not end merely because the hand stops moving.'],
  },
  {
    id: 'about-work-04', index: '10',
    titleKo: '04 기록 / RECORD', titleEn: '04 RECORD',
    leadKo: '완성된 작품 뒤에서 사라지는 손과 제작의 시간을 남긴 소리 없는 영상입니다.',
    leadEn: 'A silent moving-image record of the hands and making time that disappear behind the finished work.',
    bodyKo: ['정해진 처음과 마지막이 없습니다. 어느 장면에서 들어오고 나가도 되며 여러 사람이 함께 관람할 수 있습니다.'],
    bodyEn: ['There is no required beginning or ending. Enter or leave at any scene. The film does not require exclusive use and can be watched by several people at once.'],
    deeperKo: ['04는 캡처를 만들거나 앞선 작품의 결과를 해석하지 않습니다. 연결부, 실패, 반복과 물질의 시간을 독립된 기록으로 남깁니다.'],
    deeperEn: ['04 does not create a personal capture or interpret the results of the other works. It preserves joins, failures, repetitions and material labour as an independent record.'],
  },
  {
    id: 'about-phone', index: '11',
    titleKo: '당신의 장미와 Phone Hub', titleEn: 'YOUR ROSE AND THE PHONE HUB',
    leadKo: 'Phone Hub는 작품을 작동시키는 의무가 아니라 색, 선택적 이름과 요청한 캡처를 다시 찾는 선택형 동반자입니다.',
    leadEn: 'The Phone Hub is an optional companion for returning colour, an optional name and requested captures, rather than a requirement for operating the works.',
    bodyKo: ['장미 번호는 본명 대신 이 관람의 장면을 다시 찾기 위한 무작위 표식입니다. 작품 01, 02, 03에서 관객이 요청한 캡처만 자신의 번호로 돌아옵니다. 04에는 개인 캡처가 없습니다.'],
    bodyEn: ['The Rose number is a random marker used to return this visit’s images without asking for a legal name. Requested captures from Works 01, 02 and 03 return to that number. Work 04 has no personal capture.'],
    deeperKo: ['실시간 카메라 처리는 작품 안에서 일어나며 관객이 캡처를 요청하는 것과 구분됩니다. 휴대폰 없이 이용할 수 있도록 현재 설치된 참여 방식은 스태프에게 확인해주세요.'],
    deeperEn: ['Live camera processing inside a work is distinct from a visitor-requested capture. Ask staff which phone-free participation method has been installed for each physical work.'],
  },
  {
    id: 'about-access', index: '12',
    titleKo: '참여 방식과 접근성', titleEn: 'WAYS TO TAKE PART AND ACCESS',
    leadKo: '만지기, 스태프가 확인한 현장 대체 입력 사용하기, 바라보고 듣기 모두 유효한 참여입니다.',
    leadEn: 'Touching, using a staff-confirmed installed alternative input, and watching or listening are all valid ways to take part.',
    bodyKo: ['도움을 원하면 스태프에게 어떤 방식이 편한지 알려주세요. 휴대폰, QR, NFC, 이름, 캡처와 설문은 필수가 아닙니다. 언제든 쉬거나 나갔다 다시 들어올 수 있습니다.'],
    bodyEn: ['If you would like support, tell a staff member what works best for you. A phone, QR, NFC, name, capture and survey are never required. You may pause, leave or return at any time.'],
    deeperKo: ['빛, 소리, 움직이는 추상 영상, 실제 장미의 향과 꽃가루, 접촉과 카메라 처리에 관한 감각 정보는 별도 Access & Sensory Guide에서 확인할 수 있습니다.'],
    deeperEn: ['Information about light, sound, moving abstract imagery, real-rose scent and pollen, touch and camera processing is available in the separate Access & Sensory Guide.'],
  },
];

// These expansions restore depth that was present in the approved Seoul
// curatorial copy and the approved bilingual portfolio narrative. They add no
// new Melbourne installation claims: obsolete skeleton, pattern/NFC and
// mandatory-route details are deliberately excluded.
const APPROVED_DEEPER_EXPANSIONS = {
  'about-intro': {
    ko: [
      '이 작품은 스스로 밀어내거나 없애려 한 나의 면을 하나의 개인적 결함으로만 보지 않습니다. 완벽함을 요구하는 시선, 쓸모와 생산성을 기준으로 자신을 평가하는 습관, 좋아 보이는 모습만 남기려는 이미지 문화가 한 사람의 내부에서 어떻게 작동하는지를 함께 봅니다.',
      '그래서 이 장례는 누군가를 완전히 보내기 위한 의식이 아니라, 내가 없앴다고 믿은 것이 어떤 모습으로 돌아오는지 살피는 자리입니다.',
      '내가 죽여 온 나를 위한 장례식. 우리 자신에게서 반복해서 지우려 했던 부분은 무엇이 되는가?',
      '장례식은 배제하거나 바꾸고 남겨둔 자신을 다시 마주하는 자리가 됩니다.',
      '전시는 명명, 개입, 목격, 기록의 네 부분으로 구성됩니다. 터치, 제스처, 가까워짐과 관찰을 통해 각각 신체와 이미지 사이에 서로 다른 관계를 만듭니다. 정해진 순서로 완료하는 과정이 아니라 서로 구별되는 만남으로 구상한 네 작업은 돌봄과 훼손, 아름다움과 불편함을 나란히 놓고, 상충하는 상태가 함께 존재하는 양가성을 다룹니다.',
    ],
    en: [
      'The work does not treat the parts we have pushed away as private defects alone. It also considers how demands for perfection, habits of judging the self through usefulness and productivity, and image cultures that preserve only an acceptable face can operate inside one person.',
      'This funeral is therefore not a ritual for making someone disappear, but a place to notice how what seemed removed returns.',
      'A funeral for the self I have killed. What becomes of the parts of ourselves we repeatedly try to remove?',
      'The funeral becomes a setting in which to encounter what has been excluded, altered or left behind.',
      'The exhibition comprises four parts: Naming, Intervention, Witness and Record. Each establishes a different relationship between a body and an image, through touch, gesture, proximity or observation. The four parts are conceived as distinct encounters rather than a prescribed sequence. Together, the works place care beside damage and beauty beside discomfort, approaching ambivalence as the coexistence of conflicting states.',
    ],
  },
  'about-vanitas': {
    ko: [
      '여기의 장미와 죽음의 형상은 단순한 장례 장식이나 고딕 이미지가 아닙니다. 장미는 관객의 접촉과 움직임에 빛과 소리로 반응하고, 죽음의 형상은 움직이는 이미지 안에서 관객의 개입과 목격을 기다립니다.',
      '바니타스가 죽음을 기억하게 했다면, 이 작업은 자신이 무엇을 계속 죽이고 있는지 보게 합니다. 기억은 관찰로 끝나지 않고 무엇과 어떤 관계를 다시 맺을지 고르는 행동으로 이어집니다.',
      '꽃은 피어 있는 순간에도 시들고 있고, 해골은 한때 살아 움직였던 몸의 시간을 품습니다. 이 작업은 서로 반대되는 상태가 같은 장면 안에 동시에 존재하는 그 구조를 오늘의 자기 인식으로 옮깁니다.',
      '장미는 사람들의 손길을 거치고 마르며 시드는 동안에도 달라집니다. 장미의 시간은 다시 시작할 수 있는 디지털 시스템의 시간과 다릅니다. 사진은 재료의 특정한 모습을 남기지만 그 변화 자체를 되돌리지는 않습니다. 반복 가능한 이미지와 되돌릴 수 없는 생명 과정 사이의 긴장은 전시 이후의 장미를 지속적으로 기록하는 Park의 작업과 The Funeral을 연결합니다.',
    ],
    en: [
      'The roses and figures of death are not funeral decoration or gothic imagery alone. The roses respond to audience touch and movement through light and sound, while figures of death wait to be intervened in and witnessed within moving images.',
      'If vanitas asked viewers to remember death, this work asks what we continue to kill within ourselves. Remembering does not end in observation; it leads toward choosing what relationship might be made again.',
      'A flower is already withering while it blooms, and a skull carries the time of a body that once moved. The work brings this coexistence of apparently opposing states into present-day self-perception.',
      'The roses also change through handling, drying and decay. Their time differs from a digital system that can restart. Photographs preserve particular appearances of these materials, but do not reverse the changes themselves. This tension between a repeatable image and an irreversible living process connects The Funeral to Park’s continuing documentation of roses after exhibition.',
    ],
  },
  'about-rose': {
    ko: [
      '생화와 조화를 진짜와 가짜의 위계로 나누지 않습니다. 생화는 변화하고 소멸하는 몸이고, 조화는 변하지 않도록 붙잡힌 기억입니다. 하나는 살아 있어서 사라지고, 다른 하나는 죽어 있어서 오래 남습니다.',
      '같은 성질이 어떤 순간에는 자신을 지키고, 다른 순간에는 자신과 타인을 찌를 수 있습니다. 그래서 장미와 색을 좋은 감정이나 나쁜 감정 하나로 고정하지 않습니다.',
      '마지막에 보이는 디지털 장미도 완성된 자아의 초상이 아닙니다. 관객이 고른 색과 선택적 이름, 요청한 캡처와 확인된 방문 기록 곁에 놓이는 그날의 표식입니다.',
      '장미는 물리적 재료이면서 동시에 서로 반대되는 성질을 함께 품는 감정을 다루는 형상으로 이어집니다.',
    ],
    en: [
      'Living and artificial flowers are not divided into a hierarchy of real and fake. A living flower is a changing, disappearing body; an artificial flower is a memory held against change. One disappears because it is alive, while the other remains because it is not.',
      'The same quality may protect us in one moment and wound ourselves or someone else in another. The rose and its colour are therefore not fixed to a single good or bad feeling.',
      'The digital rose is not a finished portrait of the self. It is a marker of that day, shown beside the visitor’s chosen colour, optional name, requested captures and confirmed visits.',
      'The rose remains both a physical material and a recurring figure for feelings that can contain opposing qualities at once.',
    ],
  },
  'about-ambivalence': {
    ko: [
      '돌봄은 언제나 순수하게 선하지 않고 파괴 역시 하나의 의미로만 닫히지 않습니다. 무엇을 살린다는 명목으로 지나치게 통제할 수도 있고, 없애려던 행동이 오히려 다른 흔적을 드러낼 수도 있습니다.',
      '장미 이름의 두 얼굴도 서로를 미화하거나 취소하지 않습니다. 한쪽이 다른 쪽을 이긴 결과가 아니라, 한 사람 안에 동시에 존재하는 모습을 함께 부르는 방식입니다.',
      'Phone Hub는 이런 모순을 다시 한 줄의 점수나 성격 유형으로 줄이지 않습니다. 관객이 선택한 색과 선택적 이름, 요청한 캡처와 확인된 방문 기록만 남깁니다.',
      '카메라 기반 제스처 추적과 반응형 컨트롤러가 참여자의 행동을 디지털 해골 신체에 연결합니다. 관객은 그 균형과 생명력을 변화시키며, 개입이 결과를 수반하는 행위임을 마주합니다. 장미와 해골, 돌봄과 훼손, 행동하는 나와 지켜보는 내가 하나의 이미지 안에 공존합니다.',
    ],
    en: [
      'Care is not always purely good, and damage does not close around a single meaning. An attempt to preserve something may become control, while an act meant to remove something may reveal another trace.',
      'The two faces held in a rose name do not beautify or cancel one another. The name is not the result of one side winning, but a way of calling forms that can exist in the same person at once.',
      'The Phone Hub does not reduce this contradiction to a score or personality type. It keeps only the visitor’s chosen colour, optional name, requested captures and confirmed visits.',
      'Camera-based gesture tracking and a responsive controller connect the participant’s actions to a digital skeletal body. Visitors alter its balance and vitality, bringing intervention into view as an action with consequences. Rose and skeleton, care and damage, the self who acts and the self who watches occupy the same image.',
    ],
  },
  'about-choice': {
    ko: [
      '감정 단어를 먼저 보여주지 않는 이유는 관객의 언어가 시스템이 제시한 예시를 따라가지 않게 하기 위해서입니다. 설명을 읽고 정답을 수행하는 대신, 몸이 장미와 기계에 닿은 뒤에 말이 오도록 합니다.',
      '선택권은 작품의 책임을 관객에게 떠넘기기 위한 말이 아닙니다. 죽음과 애도를 다루는 만큼 화면은 강요보다 예고를, 평가보다 되돌릴 수 있는 선택을 먼저 제공합니다.',
      '관객은 작품 안에서 보이는 사람이면서 동시에 보는 사람이고, 시스템을 움직이는 입력이면서도 언제든 그 관계를 멈출 수 있는 사람입니다.',
      '연결된 폰 인터페이스에서는 선택한 이미지와 작성한 응답을 남길 수 있습니다. 이 흔적은 작품 안에서의 참여와 선택을 기록하며, 누군가의 감정 상태를 객관적으로 판독한 결과로 제시되지 않습니다. 이는 감정적 경험을 고정된 이름으로 축소하지 않으면서 어떻게 기록할 수 있을지에 관한 프로젝트의 탐구에서 중요한 구분입니다.',
    ],
    en: [
      'Emotional words are not offered first because the visitor’s language should not simply follow an example supplied by the system. Rather than reading an answer and performing it, words may arrive after the body has met the roses and machines.',
      'Offering choice does not transfer the work’s responsibility to the visitor. Because the project deals with death and mourning, it puts warning before pressure and reversible choices before evaluation.',
      'The visitor is both the person seen within the work and the person looking. They are an input that changes the system, and also someone who may stop that relationship at any time.',
      'A connected phone interface offers a place to retain selected images and written responses. These traces record participation and choices within the work; they are not presented as an objective reading of someone’s emotional state. The distinction is central to the project’s developing inquiry into how affective experience might be recorded without reducing it to a fixed label.',
    ],
  },
  'about-ritual': {
    ko: [
      '이 순서는 치료의 단계나 회복의 정답이 아닙니다. 작품을 본 뒤 더 나아졌다고 말하도록 요구하지도 않습니다. 의식의 역할은 한 사람 안의 모순을 없애는 것이 아니라, 평소에는 겹쳐 보이지 않던 것들을 같은 시간 안에 놓는 것입니다.',
      '명명, 개입, 목격과 기록은 서로 다른 방식으로 몸과 이미지의 관계를 만듭니다. 네 작품은 정해진 절차가 아니라 구별되는 만남으로 놓이며, 한 작품만 보거나 순서를 바꾸거나 관람만 해도 완전한 참여입니다.',
      '마지막에 남는 장미의 색과 선택적 이름은 삭제하거나 버릴 결론이 아니라, 전시 밖에서도 다시 돌아볼 수 있는 그날의 표식입니다.',
      '소리 없이 반복되는 영상은 전시를 만드는 과정으로 시선을 되돌립니다. 손, 실패한 테스트, 상처, 연결과 반복된 노동이 완성된 표면 뒤로 사라지지 않고 드러납니다. 이 기록은 관객과의 만남에 앞서 있었던 재료와 신체의 작업을 담으며 반응형 작품들과 나란히 놓입니다.',
    ],
    en: [
      'This sequence is not a treatment plan or a correct path to recovery, and it does not require visitors to report that they feel better. The ritual does not remove contradiction; it places things that are usually kept apart within the same time.',
      'Naming, Intervention, Witness and Record each create a different relationship between body and image. They are distinct encounters rather than a prescribed procedure. Visiting one work, changing the order or simply observing are all complete forms of participation.',
      'The colour and optional name that remain are not a conclusion to discard. They are markers of that day that may be revisited outside the exhibition.',
      'A silent, looping film returns attention to the making of the exhibition. Hands, failed tests, cuts, connections and repeated labour remain visible, rather than disappearing behind a completed surface. This record sits alongside the responsive works as an account of the material and bodily work that precedes an audience’s encounter.',
    ],
  },
  'about-work-01': {
    ko: [
      '각 장미는 서로 다른 빛과 소리의 층을 가집니다. 오래 머물면 반응이 깊어지고, 다른 장미를 만지면 여러 층이 결합해 계속 달라지는 오디오비주얼 구성을 만듭니다.',
      '살아 있는 꽃을 만지는 행동은 돌봄이면서 동시에 꽃의 시간을 앞당기는 접촉입니다. 가능한 조합 전체를 소유하기보다, 혼자 또는 함께 만든 임시적인 회로 안에서 몸이 실제로 반응하는 한순간의 균형을 찾습니다.',
    ],
    en: [
      'Each rose carries a distinct layer of light and sound. Sustained contact deepens a response, while touching different roses combines layers into a changing audio-visual composition.',
      'Touching a living flower is an act of care that also advances the flower’s time. Rather than possessing every possible combination, the visitor finds one temporary balance to which the body responds, alone or within a shared circuit.',
    ],
  },
  'about-work-02': {
    ko: [
      '관객은 관찰자가 아니라 적극적으로 개입하는 사람입니다. 관객의 선택은 화면 속 존재를 돌보거나 해치는 실제 사건이 됩니다.',
      '돌봄과 손상은 깨끗하게 분리되지 않습니다. 살리기 위한 개입이 다른 균형을 무너뜨릴 수 있고, 파괴적인 행동 뒤에도 생명은 다시 일어납니다.',
      '엄지와 검지로 만든 사각형 안에는 카메라 화면이 나타납니다. 관객은 자신이 해치고 돌보는 스켈레톤 위에서, 그 행동을 선택하고 지켜보는 자신의 얼굴을 만나게 됩니다.',
      '다섯 손가락 마스크에는 관객이 고른 색과 선택적 장미 이름이 더해집니다. 화면 속 존재는 장미이자 스켈레톤, 삶이자 죽음이라는 두 얼굴을 같은 몸에 둡니다.',
    ],
    en: [
      'The visitor does not only observe; they actively intervene. Their choices become events that care for or damage the figure on screen.',
      'Care and damage do not separate cleanly. An intervention intended to preserve one balance may disturb another, while life may return after a destructive action.',
      'A rectangle formed with thumb and index finger reveals the camera image. Over the skeleton being cared for and harmed, the visitor encounters the face that chose and watched those actions.',
      'The five-finger mask adds the visitor’s chosen colour and optional rose name. Rose and skeleton, life and death, remain as two faces of the same body.',
    ],
  },
  'about-work-03': {
    ko: [
      '01이 내 안의 공명을 찾고 02가 나의 행위를 조금 떨어져 바라보는 작품이라면, 03은 더 넓은 세계의 언어와 시간 속에 나의 죽음과 장미를 놓아보는 자리입니다.',
      '세 번의 목격은 정답을 세 번 확인하는 과정이 아닙니다. 같은 장미도 시간과 거리, 내가 선 위치에 따라 다르게 보인다는 사실을 몸으로 확인하는 과정입니다.',
      '시간은 완전히 멈추지 않습니다. 모든 장면을 붙잡는 대신 손을 가까이 가져가 속도에 개입하고, 자기 자신을 찬찬히 바라볼 시간을 스스로에게 줍니다.',
      '장미가 선명해지는 것은 죽음이 사라졌다는 뜻이 아닙니다. 왜곡되어 있던 한 얼굴과 그 반대편 얼굴을 같은 서사 안에서 함께 볼 수 있게 되었다는 뜻에 가깝습니다.',
    ],
    en: [
      'Where 01 searches for resonance within the self and 02 observes one’s actions from a slight distance, 03 places one’s death and rose within the languages and time of a wider world.',
      'Three acts of witness do not confirm a correct answer three times. They make bodily the fact that the same rose changes with time, distance and the position from which it is seen.',
      'Time never stops completely. Rather than holding every scene, the visitor intervenes in its speed and grants themselves time to look carefully.',
      'The rose becoming clear does not mean that death has disappeared. It means that a distorted face and its other face can be seen within the same narrative.',
    ],
  },
  'about-work-04': {
    ko: [
      '제작 기록은 다른 작품을 설명하는 부록이나 홍보 영상이 아닙니다. 작품이 어떤 노동과 반복을 지나 만들어졌는지를 보여주는 독립된 기록입니다.',
      '인터랙티브 미디어 작품 뒤에는 전선을 자르고 잇는 손, 형태를 만드는 손, 실패한 테스트와 다시 시작된 연결의 시간이 있습니다.',
      '기술을 매끄러운 마술처럼 보이게 하기보다 연결부와 손의 흔적을 남깁니다. 기계 역시 몸을 가지고 있고, 그 몸은 수많은 손의 노동과 오류를 통해 만들어집니다.',
      '영상에 정해진 처음과 마지막이 없는 이유도 여기에 있습니다. 어느 장면에서 들어와도 손은 이미 무언가를 만들고 있고, 어느 순간 떠나도 작업은 다른 곳에서 계속됩니다.',
    ],
    en: [
      'This record is not an appendix or promotional explanation of the other works. It stands independently as an account of the labour and repetition through which the installation was made.',
      'Behind an interactive media work are hands that cut and join cables, hands that shape forms, failed tests and restarted connections.',
      'Rather than making technology appear as seamless magic, the film keeps joins and traces of the hand visible. The machine also has a body, built through repeated labour and error.',
      'This is also why the film has no fixed first or last scene. Wherever a visitor enters, hands are already making something; whenever they leave, the work continues elsewhere.',
    ],
  },
  'about-phone': {
    ko: [
      'Phone Hub는 작품의 실시간 화면을 복제하지 않습니다. 각 작품이 실제로 필요로 하는 최소한의 정보만 연결하고, 관객이 직접 요청한 캡처가 자신의 장미 번호로 돌아오게 합니다.',
      '장미 번호는 본명 대신 오늘의 선택을 다시 찾기 위한 무작위 표식입니다. 사람을 식별하기 위한 이름이 아니라 서로 떨어진 장면이 어느 장미로 돌아가야 하는지 알려주는 연결입니다.',
      '현재의 장미는 완성된 초상이 아닙니다. 관객이 고른 색과 선택적 이름, 요청한 캡처와 확인된 방문 기록 곁에 놓이는 그날의 표식이며, 성격 유형이나 감정의 객관적 판독으로 제시되지 않습니다.',
      '실시간 카메라 처리는 작품 안의 반응을 만들기 위한 것이며, 관객이 별도의 동작으로 요청하는 이미지 저장과 구분됩니다.',
    ],
    en: [
      'The Phone Hub does not duplicate the artworks’ live screens. It connects only the information each work needs and returns captures requested by the visitor to their Rose number.',
      'The Rose number is a random marker used to find today’s choices without asking for a legal name. It does not identify a person; it tells separated images which rose they should return to.',
      'The current rose is not a finished portrait. It is a marker of that day, shown beside a chosen colour, optional name, requested captures and confirmed visits. It is not presented as a personality type or objective reading of emotion.',
      'Live camera processing creates responses inside a work. It is distinct from storing an image after a visitor makes a separate capture request.',
    ],
  },
  'about-access': {
    ko: [
      '작가는 관객에게 어떤 감정을 느껴야 하는지 말하지 않고, 불편함을 끝까지 견디라고 요구하지 않습니다. 가까이 갈지, 만질지, 바라볼지, 이름이나 장면을 남길지는 관객이 정합니다.',
      '이 작업은 치료를 약속하거나 스스로 밀어냈던 면이 사라졌다고 선언하지 않습니다. 그 면과 그 안의 다른 얼굴을 동시에 바라볼 수 있는 짧은 조건을 만들고자 합니다.',
      'Phone Hub 연결이 어려워도 작품을 관람할 수 있으며, 현장에 설치된 시작 방법은 작가에게 확인할 수 있습니다. 남겨진 데이터보다 관객의 경험을 우선합니다.',
    ],
    en: [
      'The artist does not tell visitors what they should feel or require them to endure discomfort. Visitors decide whether to approach, touch, observe, name or keep an image.',
      'The work does not promise treatment or declare that a rejected side of the self has disappeared. It tries to create a brief condition in which that side and its other faces may be seen together.',
      'If the Phone Hub connection is unavailable, visitors may still observe the works and ask the artist which on-site start method has been installed. The visitor’s experience takes priority over the data left behind.',
    ],
  },
};

for (const section of ABOUT_SECTIONS) {
  const expansion = APPROVED_DEEPER_EXPANSIONS[section.id];
  if (!expansion) continue;
  section.deeperKo = [...(section.deeperKo || []), ...expansion.ko];
  section.deeperEn = [...(section.deeperEn || []), ...expansion.en];
}
