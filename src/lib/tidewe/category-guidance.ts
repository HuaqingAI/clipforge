import { resolveTideweShopCategory, type TideweShopCategory } from "./categories";

interface CategoryExamples {
  label: string;
  copyAngles: string[];
  visualExamples: { context: string; ordinaryUse: string; detail: string };
  productFocusExample: string;
  contactAndFocus: string;
  evidenceLimits: string;
}

const ENVIRONMENT_FOCUS = "保留现有环境：近处与中景清楚可辨；轻微柔化只允许用于主体后方的远背景，其原有结构仍可读；不添加原场景没有的景物。所有景别（包括近景和特写）中，原画面已有近处地面、台面或支撑面从画面下边缘延伸至可见接触处时，该段连续区域自然清楚可读，不允许画面底边模糊带。主体前方全部已有前景均清楚可读，包括不与商品或支撑面相连的独立近物及画幅边缘，没有近物失焦例外；不新增原画面不存在的支撑或场景，不要求所有距离同等锐利。";

const EXAMPLES: Record<TideweShopCategory, CategoryExamples> = {
  hunting_blind: {
    label: "狩猎帐篷",
    copyAngles: ["从当前帐篷的实际布置、进出空间或可见开口，提出一个选用时会检查的问题。"],
    visualExamples: {
      context: "参考中的帐篷完整立在现有营位，保留真实尺寸与周围空间。",
      ordinaryUse: "人物已站在参考支持的现有入口旁，扶住可见边缘并完成一个小幅普通操作。",
      detail: "近看参考支持的面料接缝、现有开口边缘或连接处，保留手部接触与结构关系。",
    },
    productFocusExample: "参考中的帐篷入口边缘与人物手部接触处，构图包含实际开口及邻近支撑。",
    contactAndFocus: `帐篷底边、现有支撑与附近地面共享透视和接触阴影；入口、手和同焦平面的面料连贯清楚。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "只展示参考支持的开口与操作；不由画面猜测门型、可视角度、透视能力、隔音或防风防雨性能。",
  },
  waders: {
    label: "涉水服",
    copyAngles: ["围绕穿着准备、参考支持的版型和可见连接部位，解释一个实际选用问题。"],
    visualExamples: {
      context: "人物在平稳干燥岸边穿好参考中的涉水服，展示整体穿着关系。",
      ordinaryUse: "手已搭在参考支持的现有背带或扣件，作一次小幅整理后停稳。",
      detail: "观察参考中可见的接缝、胸前部位或脚部连接，保持衣料与身体接触自然。",
    },
    productFocusExample: "参考中的涉水服可见背带连接与接触的手，包含邻近衣料和身体支撑。",
    contactAndFocus: `涉水服与身体贴合、手部接触和脚下支撑连贯，主体附近地面与同焦平面衣料自然可辨。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "不以普通穿着或岸边镜头证明防水、保温或安全水深；不由连体外形推断隐藏结构，不安排危险水流测试。",
  },
  heated_gear: {
    label: "加热装备",
    copyAngles: ["围绕当前加热装备的实际形态、穿戴或使用准备，以及已确认的供电条件，展开一个具体选择。"],
    visualExamples: {
      context: "在真实户外使用位置展示当前参考中的加热装备整体，保留它实际的穿戴或支撑方式。",
      ordinaryUse: "人物按当前装备的真实用途穿戴、持握或使用，手已接触一个参考支持的可见部位。",
      detail: "近看当前装备参考中已有的面料、连接或可见控制部位；没有该部件就选择其他可见细节。",
    },
    productFocusExample: "参考中当前加热装备的实际可见部件与手部接触处，不添加未展示的控制器或电池。",
    contactAndFocus: `按实际产品形态保持穿戴贴合或支撑接触，手、装备表面和同焦平面环境共享细节、曝光与阴影。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "加热装备不等于加热衣服；不默认加热区、温度、档位、续航或附送电池。只用当前已确认事实说明功能，不用发光、热成像或剖面制造证据。",
  },
  apparel: {
    label: "服装",
    copyAngles: ["从当前服装的穿着搭配、版型或参考支持的面料细节，提出可实际观察的选择。"],
    visualExamples: {
      context: "人物在真实使用环境中穿着参考服装，以适当景别显示整件衣服与身体的关系。",
      ordinaryUse: "人物整理当前衣服已有的袖口或衣摆，或做一次自然抬臂，保持衣料随身体受力。",
      detail: "手已接触参考中可见的面料、接缝或现有扣件，近看一次轻触及自然褶皱。",
    },
    productFocusExample: "参考服装的现有袖口或衣料接缝及接触的手，构图保留邻近穿着部位。",
    contactAndFocus: `衣料随身体受压和褶皱，手、面料与同焦平面周边清晰度一致，人物边缘不出现人像蒙版虚化。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "不默认迷彩、加热、防水、保暖或降噪功能；触摸和抬臂只能展示外观及普通穿着，不能证明长期舒适或耐用。",
  },
  boots: {
    label: "靴子",
    copyAngles: ["从当前靴子的穿着关系、筒口或参考支持的鞋底外观，解释实际选用时要看的部位。"],
    visualExamples: {
      context: "人物穿着参考中的靴子站在平稳地面，构图容纳实际靴筒、脚与周围环境。",
      ordinaryUse: "已经穿好的靴子完成一次普通短步并停稳，或手轻整参考中已有的筒口部件。",
      detail: "在参考支持相应视角时观察靴筒、筒口或外底纹理；讨论哪个部位就将该部位实际纳入画面。",
    },
    productFocusExample: "参考中实际靴筒与小腿、筒口接触关系；讨论外底时则用参考支持的外底视角。",
    contactAndFocus: `靴底、周围地面与现有落叶自然连贯；靴筒、接触的手和同焦平面表面可辨。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "靴子主类不等于防水靴或防蛇靴；普通踩踏和外底沟纹不证明防蛇咬、防水、抓地、认证或保温性能。",
  },
  accessories: {
    label: "配件",
    copyAngles: ["围绕当前配件的具体用途、可见结构及有依据的普通使用，展开一个实际选择问题。"],
    visualExamples: {
      context: "在当前配件真实的携带或使用位置展示整体，保持与人物及环境的实际尺度。",
      ordinaryUse: "仅按商品名称与参考支持的用途持握、携带或接触当前配件，完成一个小幅普通动作。",
      detail: "近看当前配件参考中真实可见的部件、接缝或接触面，不套用其他配件的结构。",
    },
    productFocusExample: "当前配件参考中实际可见的部件及其支撑或手部接触关系。",
    contactAndFocus: `按当前配件实际的持握、穿戴或支撑方式保持接触阴影、透视与同焦平面细节一致。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "配件范围较广，不能仅因属于配件就默认是椅子、背包或测距仪；没有商品依据时不添加其他配件或功能。",
  },
};

const CHAIR_EXAMPLES: Partial<CategoryExamples> = {
  copyAngles: ["从当前椅子的真实坐姿、支撑位置与可见座面结构，提出坐下使用前会检查的问题。"],
  visualExamples: {
    context: "参考中的椅子放在平稳地面，构图显示完整座面、支撑与人物使用空间。",
    ordinaryUse: "人物已稳定坐在椅面上，保持受力与支撑，作一次自然姿态调整后停稳。",
    detail: "近看参考中已有的座面边缘、支撑连接或椅脚接地处，手部轻触现有部件。",
  },
  productFocusExample: "参考椅子的座面与人物坐压接触，或实际支撑连接和椅脚触地位置。",
  contactAndFocus: `臀部与座面自然受压、椅脚接地有接触阴影，座面、手及同焦平面近处地面连贯清楚。${ENVIRONMENT_FOCUS}`,
  evidenceLimits: "不由坐下或按压证明承重、舒适、静音或加热性能；不默认可折叠、旋转或调节，不能坐着调整椅脚。",
};

/** Category examples guide possible pictures; current references and frozen shot intent always govern. */
export function buildTideweCategoryGuidance(category: unknown, context: { productName?: string | null; visualObservations?: string | null } = {}) {
  const resolved = resolveTideweShopCategory(category);
  const chair = (resolved === "accessories" || resolved === "heated_gear")
    && (/\bchairs?\b|椅/i.test(context.productName ?? "") || category === "hunting_chair");
  const examples = resolved ? EXAMPLES[resolved] : {
    label: "尚未选择品类",
    copyAngles: ["仅围绕当前商品资料和参考中实际可见的外观与使用情境展开。"],
    visualExamples: {
      context: "展示参考中当前商品与真实使用空间的关系。",
      ordinaryUse: "仅安排当前参考支持的小幅普通使用或静态观察。",
      detail: "观察当前参考中可见的部件或接触位置。",
    },
    productFocusExample: "当前商品参考支持的实际部件与接触关系。",
    contactAndFocus: `主体、商品及同焦平面的现有周边在光线、颗粒、边缘和接触阴影上连贯。${ENVIRONMENT_FOCUS}`,
    evidenceLimits: "未选品类时不推断商品类型、结构或功能，不借用其他品类特征。",
  };
  return {
    category: resolved ?? "unspecified",
    ...examples,
    ...(chair ? { ...CHAIR_EXAMPLES, subtype: "chair" } : {}),
    // A heated chair still needs the main class's heating/evidence limits.
    ...(chair && resolved === "heated_gear" ? { evidenceLimits: `${EXAMPLES.heated_gear.evidenceLimits} ${CHAIR_EXAMPLES.evidenceLimits}` } : {}),
    scope: "仅为当前品类的可选文案角度与画面示例，不是当前商品事实或固定镜头模板；仅采用商品资料和参考支持的结构、动作与性能。",
  };
}
