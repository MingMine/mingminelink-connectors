/**
 * 锐明 Mock 合成数据。
 *
 * 所有设备号、租户号、车辆号、告警号与媒体域名均为虚构值，
 * 仅用于预研阶段验证接入流程与自测脚本，不得替换为真实业务数据。
 */

/** 固定 mock token，仅用于预研自测，不具备任何真实鉴权能力。 */
export const MOCK_TOKEN = "TEST-MOCK-TOKEN";

/** 固定 mock 账号，仅用于换取 token。 */
export const MOCK_ACCOUNT = "TEST-ACCOUNT";

/** 固定 mock secret，仅用于换取 token，是明显的假值。 */
export const MOCK_SECRET = "TEST-MOCK-SECRET";

/** 合成租户号。 */
export const MOCK_TENANT_ID = "100001";

/** 合成应用号。 */
export const MOCK_APP_ID = "10001";

/** 合成 RSA 公钥，仅用于校验响应结构。 */
export const MOCK_PUBLIC_KEY = [
  "-----BEGIN PUBLIC KEY-----",
  "TEST-MOCK-PUBLIC-KEY-NOT-A-REAL-KEY",
  "-----END PUBLIC KEY-----",
].join("\n");

export interface MockDevice {
  uniqueId: string;
  fleetId: string;
  onlineState: string;
  dormantState: string;
  /** 锐明原始格式：逗号分隔的通道号字符串。 */
  channels: string;
  deviceType: string;
  lanWan: string;
}

/** 合成设备：三台设备用于验证分页与过滤。 */
export const MOCK_DEVICES: MockDevice[] = [
  {
    uniqueId: "TEST00000001",
    fleetId: "TEST-FLEET-0001",
    onlineState: "ONLINE",
    dormantState: "AWAKE",
    channels: "1,2",
    deviceType: "TEST-DEVICE",
    lanWan: "PUBLIC_NETWORK",
  },
  {
    uniqueId: "TEST00000002",
    fleetId: "TEST-FLEET-0001",
    onlineState: "OFFLINE",
    // 锐明 2.7.3-P3 仅允许 AWAKE / DORMANT / UNKNOWN，不得回退为 ASLEEP。
    dormantState: "DORMANT",
    channels: "1",
    deviceType: "TEST-DEVICE",
    lanWan: "PUBLIC_NETWORK",
  },
  {
    uniqueId: "TEST00000003",
    fleetId: "TEST-FLEET-0002",
    onlineState: "ONLINE",
    dormantState: "AWAKE",
    channels: "1,2,3",
    deviceType: "TEST-DEVICE",
    lanWan: "PUBLIC_NETWORK",
  },
];

export interface MockAlarm {
  alarmId: string;
  uniqueId: string;
  vehicleId: string;
  vehicleNumber: string;
  alarmType: number;
  startTime: string;
  endTime: string;
  processStatus: string;
  realFlag: number;
}

/** 以当前时间为基准生成合成告警时间窗，确保默认“最近 24 小时”查询可命中。 */
function syntheticAlarmWindow(hoursAgo: number, durationMinutes: number): { startTime: string; endTime: string } {
  const startMs = Date.now() - hoursAgo * 60 * 60 * 1000;
  return {
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(startMs + durationMinutes * 60 * 1000).toISOString(),
  };
}

/** 合成告警：覆盖两台设备，用于验证分页与证据链接。 */
export const MOCK_ALARMS: MockAlarm[] = [
  {
    alarmId: "TEST-ALARM-0001",
    uniqueId: "TEST00000001",
    vehicleId: "TEST-VEHICLE-0001",
    vehicleNumber: "TEST-VEHICLE-01",
    alarmType: 56002,
    ...syntheticAlarmWindow(3, 1),
    processStatus: "UNPROCESSED",
    realFlag: 1,
  },
  {
    alarmId: "TEST-ALARM-0002",
    uniqueId: "TEST00000002",
    vehicleId: "TEST-VEHICLE-0002",
    vehicleNumber: "TEST-VEHICLE-02",
    alarmType: 56003,
    ...syntheticAlarmWindow(2, 2),
    processStatus: "PROCESSED",
    realFlag: 1,
  },
  {
    alarmId: "TEST-ALARM-0003",
    uniqueId: "TEST00000001",
    vehicleId: "TEST-VEHICLE-0001",
    vehicleNumber: "TEST-VEHICLE-01",
    alarmType: 56002,
    ...syntheticAlarmWindow(1, 1.5),
    processStatus: "UNPROCESSED",
    realFlag: 0,
  },
];
