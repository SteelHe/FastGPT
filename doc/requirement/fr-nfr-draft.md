# 系统需求草稿：文件级权限管理（FR / NFR）

> 来源：`doc/requirement/user-story.md`（US-1 ~ US-11）
> 说明：本文档为 requirement-refiner 中间产物，供 scenario-analyst 做深度场景分析。所有 FR 均以现有代码为基线定义「变更行为」。

## 0. 术语与技术约束（前置定义）

| 术语 | 定义 |
|------|------|
| clbs | `resource_permissions` 表中的协作者记录（tmbId / groupId / orgId + permission 角色值），见 `MongoResourcePermission`（`packages/service/support/permission/schema.ts`） |
| inheritPermission | 布尔字段，`true`=继承父级权限，`false`=独立权限。现有 dataset schema 已有此字段（默认 true），collection schema **尚未有**（需新增） |
| permissionEffectScope | 新字段（**当前代码不存在**，需新增），取值 `allChildren`（对所有子集资源生效，默认）/ `currentOnly`（仅对当前资源生效）。适用对象：dataset（所有类型）、collection（folder 类型） |
| folder | dataset 层级 `DatasetTypeEnum.folder`；collection 层级 `DatasetCollectionTypeEnum.folder` |
| 继承态资源 | 非 folder 资源无任何独立 clbs 配置（仅保留 owner）；folder 资源 clbs 与父级完全一致 |

**权限位定义（现有代码已实现，`packages/global/support/permission/constant.ts`）**：
- read = `0b100`(4)、write = `0b010`(2)、manage = `0b001`(1)、owner = `~0>>>0`（32 位全 1 = 4294967295）
- 角色值为累计位：write 角色 = `0b110`(6)（含 read）、manage 角色 = `0b111`(7)（含 write+read）
- 校验/合并使用 `sumPer(...)`（按位 OR）；owner 特殊：非 owner 资源上父级 owner 会降级为 manage（`syncCollaborators` / `mergeCollaboratorList` 已实现）

**权限校验顺序（`authDatasetByTmbId` + `getTmbPermission` 现有实现）**：
`folderPer（继承态且有 parent 则取父级权限，否则 0）` → `myPer（自身 clbs，resource_permissions 中 tmbId/groupId/orgId 三路取最高）` → `sumPer(folderPer, myPer)`。

**权限操作门槛（现有逻辑 + wiki 修订）**：
- 创建 collection：parent collection write 或 dataset write 及以上
- 修改 collection：collection write 及以上；move 需 source 与 dest folder 的 manage 权限
- 查看/列表 collection：collection read 及以上
- 删除：dataset / app 需 owner 权限；collection 需 write 权限
- changeOwner：需 owner 权限
- 配置协作者（collaborator update）：需目标资源 manage 权限及以上

**子资源定义**：
- dataset 的子资源：`type=folder 且 parentId=当前id` 的 dataset；以及该 dataset 下所有 collection
- collection 的子资源：`type=folder 且 parentId=当前id` 的 collection

**现有实现关键代码位置（集成基线）**：
- 权限常量/工具：`packages/global/support/permission/constant.ts`、`packages/global/support/permission/utils.ts`（`sumPer`/`checkRoleUpdateConflict`/`getChangedCollaborators`/`mergeCollaboratorList`）
- dataset 鉴权：`packages/service/support/permission/dataset/auth.ts`（`authDatasetByTmbId`/`authDataset`/`authDatasetCollection`/`authDatasetData`）；注意当前 `authDatasetCollection` 返回 `permission: dataset.permission`（不解析 collection 自身权限），为本次需扩展的关键点
- 检索/召回：`packages/service/core/dataset/search/`（`defaultSearchDatasetData`/`deepRagSearch`）、`search/defaultRecall/collectionFilter.ts`（`filterCollectionByMetadata`：folder collectionIds 递归展开为实际文件处，为文件级过滤的候选挂载点）、`projects/app/src/pages/api/core/dataset/searchTest.ts`（入口，dataset 级 read 鉴权 `authDataset`）
- 继承/同步：`packages/service/support/permission/inheritPermission.ts`（`syncCollaborators`/`syncChildrenPermission`/`resumeInheritPermission`）
- dataset 协作者配置：`pro/admin/src/pages/api/core/dataset/collaborator/update.ts` + `packages/service/support/permission/controller.ts`（`updateResourceCollaborators`）
- dataset move：`projects/app/src/pages/api/core/dataset/update.ts`（当前逻辑：move 恒置 `inheritPermission=true` 并同步父级 clbs —— wiki 标注的「残留 BUG」所在）
- dataset 恢复继承：`projects/app/src/pages/api/core/dataset/resumeInheritPermission.ts`
- dataset 所有权转移：`pro/admin/src/pages/api/core/dataset/changeOwner.ts` + `pro/admin/src/service/core/changeOwner.ts`
- collection CRUD：`projects/app/src/pages/api/core/dataset/collection/{create,update,delete,detail,list,listV2}.ts`
- 列表权限过滤：`projects/app/src/pages/api/core/dataset/list.ts`、`collection/listV2.ts`

**集成点（需改动/新增的接口族）**：
- 现有：`/api/core/dataset/**`（create/update/delete/detail/list/resumeInheritPermission/collaborator/list 等）
- 现有 Pro：`/api/proApi/core/dataset/**`（collaborator/update、changeOwner）
- 需新增：`/api/proApi/core/dataset/collection/collaborator/update`、`/api/core/dataset/collection/resumeInheritPermission`、`/api/proApi/core/dataset/collection/changeOwner`、存量升级接口（一键重新配置）
- `resource_permissions` 表需支持 collection 资源类型（`PerResourceTypeEnum` 现有枚举为 team/app/dataset/model/agentSkill，**不含 collection**，需新增或等价处理，见技术澄清 T-1）
- 检索链路需叠加 collection 级过滤：`authDatasetCollection` 当前返回 `permission: dataset.permission`（不解析 collection 自身权限），需新增「按用户批量解析可读 collection 集合」能力供召回使用（见 FR-11 / FR-12 / NFR-7 / T-6）

---

## 一、功能需求（FR）

### FR-1：collection 级权限数据模型与继承字段（US-1 / US-7 底座）

**描述**：系统必须为单个 collection（文件或文件夹）建立独立的权限配置能力：collection 拥有 `inheritPermission`（默认 true）字段，且 `resource_permissions` 可存储 collection 维度的 clbs。collection 的父级权限来源为 `parentId` 或 `datasetId`（folder 取 `parentId`，根级文件取 `datasetId`）。同一 dataset 下的不同 collection 必须能解析出不同的最终权限。

**优先级**：P0

**验收标准**：
- [ ] Given 存在 dataset D 与两个文件 collection C1、C2（同属 D），When 为 C1 配置 write、C2 不配置（继承 D），Then 用户 A 对 C1 校验 read/write 通过、对 C2 校验 read 依据 D 的权限解析；C1 与 C2 解析出的最终权限位可不同。
- [ ] Given collection C 为继承态且非 folder，Then C 在 `resource_permissions` 中除 owner 外无任何 clb 记录（查询返回 ≤1 条）。
- [ ] Given folder 类型 collection F 为继承态，Then F 的 clbs 与父级（parentId 或 datasetId）clbs 完全一致（逐条比对 permission 相等）。
- [ ] Given collection 上同时存在 tmbId 与所属 groupId 记录，When 校验该成员权限，Then 取两者 `sumPer` 后的最高权限（个人与 group/org 叠加）。
- [ ] Given dataset D 含 10,000 个 collection、用户 U 对其中 2,000 个有 read，When 调用「可读 collection 批量解析」（输入 tmbId + 候选集合），Then 返回恰为 2,000 个可读 collectionId，单次调用 DB 查询次数为常数（批量 `$in`），满足 NFR-7 性能指标（该批量能力供检索链路 FR-11 复用）。

**输入验证**：
- `collectionId` 必须存在且与 `datasetId`/`teamId` 归属一致；否则返回 `DatasetErrEnum.unExist` / `unAuthDataset`。
- `inheritPermission` 为布尔，缺省 true。

**错误处理**：
- 校验失败统一返回 `DatasetErrEnum.unAuthDataset`（409/403 语义沿用现有错误码体系），不得泄露资源是否存在以外的信息。

**并发/幂等要求**：
- collection 继承态解析不落库（仅查询时合成），无写并发。

---

### FR-2：collection 协作者配置接口（US-7）

**描述**：系统必须提供单文件（collection）级别的协作者配置接口 `/api/proApi/core/dataset/collection/collaborator/update`，支持：
1. 配置权限：下发全量 clbs 列表（tmbId/groupId/orgId + permission）；
2. 范围变更：修改 `permissionEffectScope`（allChildren / currentOnly）；
语义与 dataset 版 `collaborator/update` 对齐：接口下发全量 clbs，内部判断实际生效配置，folder 将全量 clbs 下发到继承态子 folder，冲突则置为非继承态并全量配置。

**优先级**：P0

**验收标准**：
- [ ] Given 具有 collection manage 及以上权限的用户，When 调用该接口为文件 C 配置协作者 U（write），Then 返回成功，且 `resource_permissions` 中新增/更新 U 对 C 的记录。
- [ ] Given 用户仅有 collection read 权限，When 调用该接口，Then 返回 `unAuthDataset`，且 `resource_permissions` 无任何变更。
- [ ] Given 配置列表为空数组，When 调用该接口，Then 返回 `CommonErrEnum.missingParams`，不做任何写入。
- [ ] Given 为 folder 类型 collection 配置全量 clbs，When 提交，Then 其下所有继承态子 folder 的 clbs 被同步为最新全量配置（增量/全量策略遵循「folder 及其子 folder 按最新全量配置」规则；非继承子 folder 不被覆盖）。
- [ ] Given 配置目标与父级无冲突且资源为继承态，When 提交，Then 不改变 `inheritPermission`，仅增量更新自身 clbs。

**输入验证**：
- `collectionId` 必填；`collaborators` 为数组，每项必须满足 tmbId/groupId/orgId 三选一且唯一；`permission` 必须为合法角色值（0b001/0b010/0b100/6/7/owner 之一）。
- `permissionEffectScope` 可选，缺省 `allChildren`；仅 folder 类型允许 `currentOnly`（非 folder 传 `currentOnly` 视为 `allChildren` 或返回参数错误——需技术澄清 T-2）。

**错误处理**：
- 越权：返回 `DatasetErrEnum.unAuthDataset`。
- 不能修改自己（tmbId 等于当前操作者）的权限：返回 `DatasetErrEnum.canNotEditAdminPermission`。
- 非 owner 修改含 manage 角色的配置：返回 `DatasetErrEnum.unAuthDataset`。
- 全流程在 mongo session（事务）内执行，任一步失败整体回滚，不产生半更新状态。

**并发/幂等要求**：
- 并发对同一 collection 配置时以最后一次提交为准；采用全量 clbs 下发，天然幂等（重复提交相同列表结果一致）。

---

### FR-3：权限生效范围 permissionEffectScope（US-2）

**描述**：系统必须为 dataset（所有类型）与 collection（folder 类型）增加 `permissionEffectScope` 字段，取值 `allChildren`（默认，权限下发给所有子资源）/ `currentOnly`（仅当前资源生效，子资源不继承）。

**优先级**：P0

**验收标准**：
- [ ] Given 新建 dataset/collection，When 查询详情，Then `permissionEffectScope` 默认为 `allChildren`。
- [ ] Given folder 资源 F 的 `permissionEffectScope=allChildren`，When 为其配置权限 P，Then 所有继承态子资源解析到 P。
- [ ] Given folder 资源 F 的 `permissionEffectScope=currentOnly`，When 为其配置权限 P，Then 仅 F 本身解析到 P，子资源不因 F 的配置获得任何权限（解析结果与配置前一致，除非子资源自身有独立配置）。
- [ ] Given 非 folder 资源（文件 collection / 普通 dataset），When 尝试设置 `permissionEffectScope`，Then 该设置不产生子资源传播效果（不生效或返回参数错误）。

**输入验证**：
- `permissionEffectScope` 仅接受枚举 `allChildren` / `currentOnly`，其他值返回参数校验错误。

**错误处理**：
- 非法枚举值：返回参数错误（沿用 zod parse 错误体系）。

**并发/幂等要求**：
- 范围变更与权限配置在同一次请求内原子完成（见 FR-5）。

---

### FR-4：创建资源时默认继承父级权限（US-3）

**描述**：系统在创建 collection / dataset 时必须执行「关联创建」逻辑：获取父集权限，若父集 `permissionEffectScope=allChildren` 则新资源 `inheritPermission=true`（自动继承，无需重复配置）；若父集为 `currentOnly` 则新资源 `inheritPermission=false`（独立态）。创建 folder 时需将父集 owner 降级为 manage 后与自己 owner 合并做全量配置。

**优先级**：P0

**验收标准**：
- [ ] Given 父目录 `allChildren` 且已有权限 P，When 创建子文件 C，Then C 的 `inheritPermission=true`，且用户对 C 的权限解析等于对父目录的解析。
- [ ] Given 父目录 `currentOnly`，When 创建子文件 C，Then C 的 `inheritPermission=false`，不继承父目录权限。
- [ ] Given 用户对父目录仅有 write，When 调用创建接口（create collection），Then 鉴权通过（parent collection write 或 dataset write 以上）。
- [ ] Given 用户对父目录无 write，When 调用创建接口，Then 返回 `unAuthDataset`，不产生任何资源与权限记录。

**输入验证**：
- 创建 collection：需传 `datasetId`；可选 `parentId`（folder 挂载点）。

**错误处理**：
- 父级缺失/越权：返回 `DatasetErrEnum.unAuthDataset`。
- 创建与初始权限配置在同一 mongo session 内完成，失败回滚（不残留无主资源或无主权限记录）。

**并发/幂等要求**：
- 同资源重复创建不适用；创建接口需防止重名/重复提交产生的孤儿权限（在事务内创建资源+写权限）。

---

### FR-5：currentOnly 下子资源停止继承（US-4）

**描述**：当 folder 资源 F 的范围从 `allChildren` 变为 `currentOnly` 时，系统必须将所有子资源的 `inheritPermission` 置为 `false`（其中未设置独立权限的子资源不继承、转为独立态），避免子资源意外获得权限。

**优先级**：P0

**验收标准**：
- [ ] Given F 为 `allChildren`、子资源 C（继承态，无独立 clbs），When 将 F 改为 `currentOnly`，Then C 的 `inheritPermission=false`。
- [ ] Given F 范围变更为 `currentOnly` 后，When 用户查询 C 的权限，Then 不再解析到 F 的权限（与变更前结果相比权限不放大）。
- [ ] Given F 范围变更为 `currentOnly`，When 校验，Then 该变更与 F 自身权限配置在同一次请求内原子生效。

**输入验证**：
- 范围变更请求必须携带目标 `permissionEffectScope` 与全量 clbs（或明确的「仅变更范围」标记，需技术澄清 T-2）。

**错误处理**：
- 变更过程中任一子资源更新失败，整体回滚，F 与子资源保持变更前状态。

**并发/幂等要求**：
- 子资源数量大时需批量化处理（BFS + bulkWrite），避免逐条等待（性能见 NFR-2）。

---

### FR-6：移动（move）时的权限处理（US-5）

**描述**：系统在移动 dataset / collection 到新父目录时，必须允许操作者选择两种策略之一（默认继承新父目录权限）：
1. **继承新父目录权限（默认）**：`inheritPermission=true`，删除自身除 owner 外的已有 clbs，将新父级权限同步到自身，并同步到所有继承态子资源；同时同步父权限到 `datasetId && type:folder` 的 collection。
2. **保持独立配置**：`inheritPermission=false`，保留原有独立 clbs，不做权限变更。

**优先级**：P0

**验收标准**：
- [ ] Given 资源 R 从目录 S 移动到目录 D，When 选择「继承新父目录权限」，Then R 的 clbs 变为 D 的 clbs（除 owner），R 的所有继承态子资源同步为 D 的权限；S 的旧权限在 R 及其子资源上**无任何残留**（逐条比对 `resource_permissions` 无 S 特有记录）。
- [ ] Given 同样场景，When 选择「保持独立配置」，Then R 及子资源的 clbs 保持不变，`inheritPermission=false`。
- [ ] Given 用户对 source folder 与 dest folder 均有 manage 权限，When 发起 move，Then 成功。
- [ ] Given 用户对 source 或 dest 任一缺少 manage 权限，When 发起 move，Then 返回 `unAuthDataset`，目标位置、权限数据均不变。
- [ ] Given 移动会形成环（目标为自身的子级），When 发起 move，Then 拒绝（沿用现有 `checkMoveFolderDepth` 的深度/环检测，限制递归深度）。
- [ ] Given move 为 dataset 且同步 `datasetId && type:folder` 的 collection，When 完成，Then 该 dataset 下所有 folder 类型 collection 同步为 dataset 新父级权限。

**输入验证**：
- move 请求必须携带目标 `parentId`（null 表示移到根目录）与继承策略标志（默认继承）；`inheritPermission` 布尔。

**错误处理**：
- 越权/环/超深度：返回对应错误码（`unAuthDataset` / 深度限制错误），不产生部分移动。
- 移动到根或从根移动：需团队 dataset 创建权限（沿用现有 `authUserPer` 逻辑）。

**并发/幂等要求**：
- 整个 move + 权限同步在单 mongo session 内完成；重复相同 move 请求结果一致（幂等）。

---

### FR-7：恢复继承（US-6）

**描述**：系统必须提供恢复继承能力（dataset 与 collection 各一接口：`/api/core/dataset/resumeInheritPermission` 与新增 `/api/core/dataset/collection/resumeInheritPermission`）：
1. 有父级且资源为 folder：将**父级权限**（不是 parent+自身 merge）同步到自身，并下发到所有 `inheritPermission=true` 的 folder 子资源；置 `inheritPermission=true`。
2. 有父级且非 folder：删除自身除 owner 外的 clbs，置 `inheritPermission=true`（资源权限干净回到父级权限）。
3. 无父级：直接置 `inheritPermission=true`。
同时，folder 恢复时需同步恢复 `datasetId` 下所有 `inheritPermission=true` 的 folder collection。

**优先级**：P1

**验收标准**：
- [ ] Given 独立配置的文件 C（含 owner + 若干额外 clbs），When 调用恢复继承，Then C 的 clbs 仅剩 owner，`inheritPermission=true`，权限解析等于父级。
- [ ] Given 独立配置的 folder F（含子级继承态 folder 链），When 调用恢复继承，Then F 及所有 `inheritPermission=true` 的子 folder 的 clbs 与 F 的父级完全一致，均置 `inheritPermission=true`。
- [ ] Given 根级资源 R，When 调用恢复继承，Then 仅将 `inheritPermission` 置为 `true`，不产生其他写操作。
- [ ] Given 用户对资源无 manage 权限，When 调用恢复继承，Then 返回 `unAuthDataset`，数据不变。

**输入验证**：
- `datasetId` / `collectionId` 必填其一。

**错误处理**：
- 失败回滚；恢复后不残留任何「父级不存在的 clb」。

**并发/幂等要求**：
- 重复调用结果一致（幂等）；大批量子 folder 恢复使用 BFS + bulkWrite。

---

### FR-8：权限冲突检测与自动取消继承（US-8）

**描述**：系统在配置资源权限时，必须将实际生效配置与父级比较：
- 变化位取最低位；若 `(parent 存在) && ((changedRole & parent.permission) !== 0 || deleted)` 判定为**冲突**（父 读(100) 子 写(010) → 无冲突；父 写(010) 子 读(100) → 冲突；权限变小=冲突，权限变大=无冲突）。
- 冲突时：资源自动置为非继承态（`inheritPermission=false`），并保留独立配置；folder 需全量下发 clbs 到继承态子 folder。
- 无冲突时：保持继承态，增量更新。
- 冲突判定补充规则：父所有者在子为 manage 或 owner，否则冲突；子的所有者，在父为 write/manage/owner，否则冲突；其余只要不同即冲突。

**优先级**：P0

**验收标准**：
- [ ] Given 父权限 read、子资源为继承态，When 将子配置为 write（比父小），Then 子 `inheritPermission=false`，且子 clbs 为独立配置（write 语义完整保留）。
- [ ] Given 父权限 read、子资源为继承态，When 将子配置为 manage（比父大），Then 子保持 `inheritPermission=true`（无需取消继承），仅增量更新。
- [ ] Given 删除（deleted）父级已有协作者，When 提交配置，Then 判定冲突并取消继承。
- [ ] Given folder 子资源冲突取消继承，When 完成配置，Then 所有继承态子 folder 获得全量 clbs 同步。

**输入验证**：
- 冲突判定输入：parentClbs、newChildClbs（现有 `checkRoleUpdateConflict` 可复用并需扩展为 wiki 修订版冲突规则）。

**错误处理**：
- 冲突本身不是错误，是触发「取消继承」的正常分支，不得返回失败；仅当无权限时才报错。

**并发/幂等要求**：
- 冲突判定与状态写入在同一事务内。

---

### FR-9：所有权转移 changeOwner（US-9）

**描述**：系统必须支持 dataset 与 collection 的所有权转移（`/api/proApi/core/dataset/changeOwner` 与新增 `/api/proApi/core/dataset/collection/changeOwner`）：
1. 获取资源及其所有子资源；
2. 更新资源所有者，本资源取消继承（`inheritPermission=false`），子资源仅修改所有者（old→new）；
3. 同步更新关联的外链 / OpenAPI 表；
4. 更新 `resource_permissions` 表。
新旧所有者在协作权限表中的冲突按以下规则处理：
- 新旧所有者都有权限：取两者权限**最大值**，删除新所有者的旧记录，将旧所有者记录更新为新所有者 + 最大权限；
- 只有旧所有者有权限：直接将其记录更新为新所有者；
- 只有新所有者有权限：不做任何处理。
（注：团队所有者转移为另一功能，入口条件为当前用户是团队 owner 且团队为企业微信团队 `isWecomTeam=true`，本次范围仅资源级。）

**优先级**：P1

**验收标准**：
- [ ] Given 操作者为 dataset/collection 的 owner，When 将所有权转移给成员 N，Then 资源 `tmbId=N`，资源 `inheritPermission=false`，所有子资源 owner 更新为 N。
- [ ] Given 新旧所有者均存在于 clbs（旧=manage、新=read），When 转移，Then `resource_permissions` 中仅剩 N 的一条记录且 permission=max(manage,read)=manage，旧所有者记录被清除。
- [ ] Given 仅旧所有者在 clbs 中，When 转移，Then 旧记录更新为新所有者，无第二条记录产生。
- [ ] Given 仅新所有者在 clbs 中，When 转移，Then 该记录原样保留。
- [ ] Given 操作者非 owner，When 调用 changeOwner，Then 返回 `unAuthDataset`。
- [ ] Given 新所有者与资源不同团队，When 调用 changeOwner，Then 返回 `AppErrEnum.invalidOwner`（或等价错误），不做任何变更。

**输入验证**：
- `datasetId`/`collectionId` 与 `ownerId` 必填；`ownerId` 必须为同团队成员。

**错误处理**：
- 整个转移在事务内执行；任一步失败回滚，不产生「资源已换 owner 但权限表未更新」的中间态。

**并发/幂等要求**：
- 重复转移以最后一次为准；转移期间对资源的并发配置请求需串行或以后写为准。

---

### FR-10：存量权限一键升级（US-10）

**描述**：系统必须提供「从根开始按新逻辑重新配置所有权限」的升级接口（一次性运维/管理接口）：从根节点（无 parentId 的 dataset）出发，按新的继承语义（permissionEffectScope / 冲突取消继承 / folder 全量 clb / 非 folder 继承态仅 owner）递归重算并落库，使存量数据自动迁移到新规则。

**优先级**：P1

**验收标准**：
- [ ] Given 存量数据存在 move 残留权限、继承态非 folder 仍有 clb 等脏数据，When 执行升级接口，Then 全部资源满足新语义：非 folder 继承态仅 owner clb、folder 继承态与父级一致、冲突资源为非继承态。
- [ ] Given 升级执行中，Then 进度/失败可观测（逐根日志），失败可重入（从失败根继续或全量重跑），不产生重复/丢失。
- [ ] Given 升级完成后，When 对任意资源做权限校验，Then 结果与「新逻辑逐资源重算」一致。

**输入验证**：
- 升级接口需鉴权为系统/团队 owner 级；建议幂等键防重复并发执行。

**错误处理**：
- 单根失败不阻断其余根；失败根在日志中可定位、可重跑。

**并发/幂等要求**：
- 升级为只写权限数据的批量任务，需与用户并发配置操作协调（建议低峰执行 + 事务/行级 upsert，防止互相覆盖），详见 NFR-1/NFR-2。

---

### FR-11：知识库检索（RAG 召回）按文件级（collection 级）权限过滤（US-11）

**描述**：系统必须将知识库检索（RAG 召回 / KB 检索）的召回结果**按文件级权限过滤**：用户仅能召回其解析后具有 read 及以上权限的 collection 内容。检索链路（`searchTest`、对话 KB 召回 `defaultSearchDatasetData` / `deepRagSearch`、OpenAPI 检索）在既有 dataset 级 read 入口鉴权之上，叠加 collection 级可读集合过滤：召回候选 collection 集合（含 folder 递归展开后的实际文件）与「用户可读 collection 集合」（FR-12 批量解析）求交集。collection 级权限解析取代 `authDatasetCollection` 当前 `permission: dataset.permission` 的降级返回（改为按 collection 自身 clbs / 继承链解析）。无 read 权限的 collection 内容不得出现在任何召回结果中，且不可通过 folder 递归展开或 dataset 级权限绕过。

**优先级**：P0

**验收标准**：
- [ ] 越权召回为 0：Given dataset D 下含文件 C1（独立配置，用户 A 解析 read=0）、C2（继承态，A 可读），A 对 D 有 dataset read，When A 对 D 发起检索（searchTest / 对话召回），Then C1 命中数为 0，C2 命中正常返回。
- [ ] 漏召回为 0：Given A 对 D 下 C1、C2 均有 collection read（含经 group/org 叠加获得），When A 检索一个在 C1、C2 均有命中的 query，Then 结果同时包含 C1、C2 命中（过滤不误删 A 可读的 collection）。
- [ ] 文件级 read 门槛：Given A 对 C 解析权限 ≥ read（write=6 / manage=7 因累计位含 read），Then C 内容可召回；Given A 对 C 解析权限 = 0，Then C 内容不可召回（即使 A 有 dataset read）。
- [ ] 继承与独立语义一致：Given C 为继承态，Then 其可检索性与父级（folder / dataset）解析一致；Given C 为独立态且排除了 A，Then 即使 A 有 dataset read，C 内容仍不可召回。
- [ ] 不得经 folder 展开绕过：Given A 可读 folder F、但 F 下文件 C 为独立态且 A 无 read，When 召回经 F 的 collectionIds 展开，Then C 内容仍不可召回（展开后逐文件过滤）。
- [ ] 存量等价回归：Given 未配置任何独立权限（全继承态）的 dataset，When 升级前后对同一 query 检索，Then 召回结果一致（文件级过滤在「无独立配置」场景下与既有 dataset 级行为等价）。
- [ ] 全路径一致：searchTest / 对话 KB 召回 / OpenAPI 检索均按同一过滤规则生效（代码可验证：各入口复用同一「可读 collection 批量解析」函数，无旁路绕过）。

**输入验证**：
- 检索请求入参不变（`datasetId` 仍为入口，沿用现有 `SearchDatasetTestBodySchema` 等 schema）；内部新增可读 collection 解析入参为 `tmbId` + 候选 collectionId 集合（或 datasetId）。

**错误处理**：
- 用户对 dataset 无 read：沿用 `DatasetErrEnum.unAuthDataset`（入口行为不变）。
- 对单个 collection 无 read：仅导致该 collection 内容不出现，**不报错、不泄露「存在但无权」信息**（静默过滤）。

**并发/幂等要求**：
- 过滤为纯读，无写入；可读集合解析需批量加载（`$in`）并支持缓存/短路，禁止逐 collection 查询（见 NFR-7）。

---

### FR-12：统一权限校验逻辑（跨资源校验框架）

**描述**：系统必须实现统一的可复用权限校验逻辑：输入 `resourceId` + `tmbId`，按「继承态取父级权限 → 自身 clbs → 叠加 group/org」的顺序解析最终权限，供 dataset / collection / data 三层复用。collection 获取父级权限来源为 `parentId`、`datasetId`。该逻辑必须以**批量可读解析**形式暴露（输入：tmbId + 候选 collectionId 集合；输出：用户可读 collectionId 子集），供检索召回链路（FR-11）、列表权限过滤（FR-13）、数据级鉴权（`authDatasetData`）复用。

**优先级**：P0

**验收标准**：
- [ ] Given 继承态文件 C（parentId 为 folder F，F 为继承态，其父为 dataset D），When 校验用户 U 对 C 的权限，Then 沿 `C→F→D` 链向上解析到 D 的有效权限（D 非继承态时取 D 自身 clbs）。
- [ ] Given 非继承态文件 C 且有自身 clbs，When 校验，Then 解析结果为自身 clbs（不混入父级）。
- [ ] Given 用户 U 同时命中 C 的 tmbId 记录（read）与所属 group 记录（write），When 校验，Then 最终权限 = read|write。
- [ ] Given 用户 U 对 C 无任何记录，Then 校验结果无权限（拒绝）。
- [ ] Given 用户 U 与候选集合 S（100 个可读、900 个不可读），When 调用批量可读解析，Then 返回恰为 100 个可读 collectionId，且单次调用 DB 查询次数为常数（批量 `$in`，非逐条）。
- [ ] Given 检索链路调用批量可读解析中途失败，Then 降级策略不放大权限（按最小可读集合处理或拒绝该次召回），不因解析失败导致越权召回。

**输入验证**：
- `resourceId`、`tmbId` 必填且为合法 ObjectId。

**错误处理**：
- 资源不存在返回 `unExist`；越权返回 `unAuthDataset`。

**并发/幂等要求**：
- 纯读校验，无写入；需为高并发查询优化（缓存/聚合，见 NFR-1）。

---

### FR-13：collection 增删改查权限门槛（操作级鉴权）

**描述**：系统必须按以下门槛对 collection 各操作执行鉴权：
- create collection：parent collection write 或 dataset write 及以上；
- update collection：collection write 及以上；move 操作需 source 与 dest folder 的 manage 权限（含移到根/从根移出的团队创建权限校验）；
- detail / list collection：collection read 及以上；
- delete collection：collection write 及以上（dataset/app 删除仍为 owner）；
- collection 列表接口（`listV2`）：有 parentId 校验 parentId read，否则校验 dataset read；列表逐条权限过滤。

**优先级**：P0

**验收标准**：
- [ ] Given 用户对 dataset D 有 write、对 C 无独立权限，When 在 D 下创建 collection，Then 成功（parent collection write 或 dataset write 门槛）。
- [ ] Given 用户对 C 仅有 read，When 调用 update（改名），Then 返回 `unAuthDataset`。
- [ ] Given 用户对 source folder 有 manage、对 dest folder 仅有 read，When move C，Then 返回 `unAuthDataset`。
- [ ] Given 用户对 dataset D 无读权限但对 C（独立配置）有 read，When 调用 `listV2`（parentId=C 或 search），Then 列表中包含 C；不包含 D 下用户无权限的其他 collection。
- [ ] Given 用户对 C 有 read 无 write，When 删除 C，Then 返回 `unAuthDataset`。
- [ ] Given 列表接口在 10,000 条 collection 数据上过滤，Then 返回结果只含用户有读权限的项（正确性）且满足 NFR-1 性能指标。

**输入验证**：
- 各接口入参沿用现有 OpenAPI schema（zod），新增 move 策略参数见 FR-6。

**错误处理**：
- 全部沿用 `DatasetErrEnum` / `CommonErrEnum` 错误码，不泄露额外信息。

**并发/幂等要求**：
- 删除为 owner 级操作，需防止与并发配置冲突（事务）。

---

### FR-14：权限数据存储与同步一致性（继承/独立状态约束）

**描述**：系统必须保证权限数据在任意时刻满足以下不变量：
- 继承态非 folder 资源：`resource_permissions` 中仅 owner 记录；
- 继承态 folder 资源：clbs 与父级完全一致；
- 非继承态资源：拥有独立 clbs 配置；
- folder 配置权限时向继承态子 folder 下发全量 clbs；
- 冲突取消继承与下发、move、恢复继承等写路径均在同一事务内完成，任一步失败回滚。

**优先级**：P0

**验收标准**：
- [ ] Given 任意写操作（配置/范围变更/move/恢复继承/changeOwner）完成后，Then 对受影响子树做完整性扫描，违反上述不变量的资源数为 0。
- [ ] Given 写操作中途 DB 异常，Then 事务回滚，数据保持操作前状态（无半写）。
- [ ] Given 同一子树并发两个写操作，Then 最终状态满足不变量（后写优先或串行化，无丢失更新导致的不一致）。

**输入验证**：不适用。
**错误处理**：
- 事务失败需返回明确错误并记录审计日志。

**并发/幂等要求**：
- 所有写路径统一使用 `mongoSessionRun`；对同一资源路径的并发写需串行化（资源级锁或乐观并发控制）。

---

## 二、非功能需求（NFR）

### NFR-1：性能 —— 大文件列表权限过滤

**描述**：collection 列表（`listV2`）在单 dataset 下数千～上万个 collection 时，逐条权限计算不得造成明显性能退化。

**指标（可量化）**：
- [ ] 在 10,000 条 collection、用户命中 2,000 条（20% 有权限）的测试数据下，`listV2` 分页（pageSize=100）的 P95 响应时间 ≤ 800ms（与改造前基线相比退化 ≤ 20%）。
- [ ] 权限计算需避免 N+1 查询：单请求内 clbs 批量加载（`$in`），per-collection 解析在内存完成；禁止逐 collection 发起 DB 查询。
- [ ] 列表接口在 100 并发请求下，CPU 单核占用可接受，不触发超时（读从库 `readFromSecondary` 沿用）。

### NFR-2：性能 —— 递归深度与批量同步

**描述**：权限传播/取消继承/恢复继承涉及递归（BFS）时，深度与耗时需可控。参考风险标注：10 层 dataset + 10 层 collection。

**指标（可量化）**：
- [ ] 在「10 层 dataset 文件夹 + 10 层 collection 文件夹」链（每层 10 个子节点）的子树执行一次「配置权限（allChildren）」的写操作，P95 完成时间 ≤ 5s。
- [ ] 同级批量同步使用 `bulkWrite` 批量写入，禁止逐条 await；单层子节点 ≥ 1,000 时仍可完成。
- [ ] 同步过程对同节点不重复遍历（visited 去重），避免环导致的死循环（配合 FR-6 的环检测）。
- [ ] `syncChildrenPermission` / `resumeInheritPermission` 的超时阈值建议 30s，超过则任务失败回滚并记录日志。

### NFR-3：正确性 —— 权限无残留、无冲突、无泄漏

**描述**：move / 恢复继承 / 配置变更 / changeOwner 后，权限必须无残留、无冲突、无泄漏。

**指标（可量化）**：
- [ ] move（继承新父级）后，源目录特有 clb 在被移动子树中残留数为 0（自动化校验脚本：逐条比对前后 `resource_permissions`）。
- [ ] 恢复继承后，非 owner clb 残留数为 0。
- [ ] 任意用户组合下，「无权限用户可读/可写/可管理」的越权访问数为 0（渗透/负向用例全通过）。
- [ ] 冲突取消继承后，独立配置完整保留（写入值与请求一致）。

### NFR-4：兼容性 —— 存量数据迁移与检索行为

**描述**：存量数据升级后权限语义正确迁移；检索文件级过滤对存量 collection（含升级前从未配置过独立权限、默认继承态的数据）生效且语义正确——未配置独立权限的继承态 collection 在检索中与既有 dataset 级行为等价，已配置独立权限的 collection 按新语义过滤。

**指标（可量化）**：
- [ ] 升级接口（FR-10）在含脏数据的存量库执行后，抽样 ≥ 1,000 个资源逐条对照新逻辑重算结果，一致率 100%。
- [ ] 升级后旧版本仍支持的读操作（list/detail/search/read）结果与升级前（按新语义解释）一致；RAG 检索回归用例（见 FR-11 验收标准第 6 条：全继承态 dataset 升级前后召回一致）全通过。
- [ ] 不引入对现有 `resource_permissions` 表结构不兼容的变更（仅扩展字段/枚举，不加不可空破坏性字段）；如需新增 collection 资源类型，采用增量枚举值，旧数据可读。

### NFR-5：安全 —— 鉴权、越权防护与审计

**描述**：所有权限写操作与敏感读操作必须鉴权；越权响应不可泄露信息；敏感操作留审计日志。

**指标（可量化）**：
- [ ] 权限写接口（collaborator update、changeOwner、resumeInheritPermission、升级）100% 校验 manage/owner 门槛，负向用例（read 用户调用）全部返回 `unAuthDataset`。
- [ ] 越权响应仅返回通用错误码，不包含资源名、其他用户信息、权限明细。
- [ ] 关键写操作（配置、范围变更、move、恢复继承、changeOwner）写入审计日志（沿用 `AuditEventEnum` 扩展），含操作者 tmbId、资源、变更前后权限摘要。
- [ ] 操作者不得通过配置接口移除/修改自身权限以造成提权或锁死（沿用 `canNotEditAdminPermission` 保护）。

### NFR-6：可靠性 —— 事务一致性与幂等

**描述**：权限写路径必须保证事务一致性与可重复执行。

**指标（可量化）**：
- [ ] 所有写路径（配置/范围变更/move/恢复继承/changeOwner/升级）100% 使用 mongo session 事务，异常时回滚（验证：注入中途失败，数据与操作前一致）。
- [ ] 重复执行同一配置/move/恢复继承请求，结果幂等（第二次执行产生 0 变更）。
- [ ] 升级任务（FR-10）可重入，中断后可重跑且不产生重复/缺失权限。

### NFR-7：性能 —— 检索（RAG 召回）热路径文件级权限过滤

**描述**：检索为高频热路径（对话 KB 召回 / `searchTest` / OpenAPI 检索），文件级权限过滤不得造成明显的检索延迟退化；「可读 collection 批量解析」必须批量高效，支持短路与缓存。

**指标（可量化）**：
- [ ] 在单 dataset 含 10,000 个 collection（用户可读 20%）下，「可读 collection 批量解析」（输入候选集合）P95 ≤ 200ms，且单次请求 DB 查询次数为常数（批量 `$in`，禁止逐 collection 查询）。
- [ ] 检索请求叠加文件级过滤后，端到端 P95 延迟较改造前基线退化 ≤ 15%（过滤不引入串行 N+1 查询；解析结果缓存/失效策略可控）。
- [ ] 对未配置任何独立权限（全继承态）的 dataset，过滤逻辑走短路路径（可读集合即全量候选集合，跳过逐 collection 解析），近似零额外开销。
- [ ] 检索高并发（单 API 100 QPS）下，过滤解析不触发超时（沿用读从库 `readFromSecondary` / 复用召回既有批量取数通道）。

### NFR-8：正确性 —— 检索文件级过滤的越权与漏召回

**描述**：检索召回结果必须与文件级权限严格一致：仅召回用户有 collection read 的内容；不得越权召回（无权限内容出现）也不得漏召回（有权限内容被误滤）。

**指标（可量化）**：
- [ ] 任意「用户 × collection 权限组合」负向用例下，无 read 权限 collection 在召回结果中的出现次数为 0（越权召回数 = 0）。
- [ ] 对用户有 read 权限且 query 语义命中的 collection，漏召回数为 0（正用例：结果包含全部可读命中，过滤不误删）。
- [ ] 权限变更（配置 / 移动 / 恢复继承）后立即重发检索请求，召回集合与变更后权限一致（过滤读取最新权限，无陈旧缓存导致的越权召回）。
- [ ] dataset 级入口与文件级过滤叠加语义正确（见 FR-11 验收标准第 1/2 条）；含继承态、独立态、group/org 叠加组合的全量检索回归用例通过率 100%。

---

## 三、技术约束汇总

1. **权限位设计**：read=0b100 / write=0b010 / manage=0b001 / owner=32 位全 1；角色值 write=6、manage=7（累计）；不得改动现有位语义（避免存量数据失效）。
2. **继承/独立状态**：`inheritPermission` 布尔语义保持；新增 `permissionEffectScope`（allChildren/currentOnly），仅 dataset 与 folder collection 可配置为 currentOnly。
3. **owner 降级规则**：父级 owner 在子资源上降级为 manage（已实现，需在 collection 层复用）。
4. **冲突规则**：permission 变小或删除 → 冲突取消继承；变大 → 无冲突保持继承；新增所有者/父所有者冲突补充规则（见 FR-8）。
5. **folder 全量 clb / 非 folder 继承态仅 owner**：作为数据不变量（FR-14）强制维护。
6. **clbs 配置方式**：接口下发全量 clbs，内部增量/全量落库（沿用 `updateResourceCollaborators`）。
7. **存储**：沿用 `resource_permissions`（`MongoResourcePermission`）；collection 维度需新增资源类型（技术澄清 T-1）。
8. **递归**：同步使用 BFS + bulkWrite；环检测与深度限制沿用 `checkMoveFolderDepth`。
9. **事务**：所有写路径统一 `mongoSessionRun`。
10. **检索过滤**：检索链路在 dataset 级入口鉴权之上叠加 collection 级可读集合过滤（FR-11）；`authDatasetCollection` 需由「返回 dataset 权限」扩展为「按 collection 自身解析」；过滤为纯读且批量（NFR-7/NFR-8）。

## 四、技术澄清问题（需在下游阶段确认）

1. **T-1（数据模型）**：collection 维度 clbs 的存储方式 —— 是给 `resource_permissions.resourceType` 新增 `collection` 枚举值，还是复用 `dataset` 类型以 collectionId 作为 resourceId？前者与现有鉴权链路（`getTmbPermission` 按 resourceType+resourceId 查询）更一致，建议新增枚举，但需确认 `PerResourceTypeEnum` 扩展对全链路（含 proApi、admin）的影响。
2. **T-2（范围变更入参）**：`permissionEffectScope` 变更是否必须伴随全量 clbs 下发，还是允许「仅变更范围」的独立请求？非 folder 资源传 `currentOnly` 是忽略还是报错？建议：folder 允许独立范围变更，非 folder 报参数错误。
3. **T-3（升级接口触发与鉴权）**：FR-10 升级接口的暴露方式（内部运维命令 vs API）、鉴权级别、是否需幂等键。
4. **T-4（collection changeOwner 交互入口）**：collection 级 changeOwner 的前端触发入口与传参（wiki 待补充项），以及外链/OpenAPI 表在 collection 级是否需要同步（FR-9 第 3 条）。
5. **T-5（「自动增加父级仅当前读权限」场景）**：wiki 标注待补充 —— 父集无权限时是否为子配置自动补父级 `currentOnly` 读权限？此逻辑影响范围判定，需在场景分析阶段确认是否实现（当前草案按「不自动扩权」处理，避免权限扩散）。
6. **T-6（检索文件级过滤与既有 dataset 级检索鉴权/召回路径的衔接）**：
   - `authDatasetCollection` 当前返回 `permission: dataset.permission`（`packages/service/support/permission/dataset/auth.ts`），若改为按 collection 自身解析，将影响其全部调用方（collection/read、detail、export、update 等）——是修改该函数返回语义，还是新增独立的「可读 collection 批量解析」函数仅检索链路使用？建议后者，降低回归面；
   - 过滤实现位置：召回前预过滤（在 `search/defaultRecall/collectionFilter.ts` 的 collectionIds 展开处叠加）vs 召回后过滤命中 `dataset_data.collectionId`？对 embedding/fullText 召回计数、reRank token 成本、`limit` 截断的影响需评估；
   - 对话 KB 召回（chat 链路）与 `searchTest` 是否统一复用同一过滤函数；OpenAPI 检索（apikey）的过滤是否按 apikey 关联的 tmbId 语义一致执行；
   - 检索叠加过滤后的延迟/成本预算基线（见 NFR-7）。
