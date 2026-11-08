export const mobileNotice = 'محاكاة الويب — ليست محاكياً أصلياً. تصدير المصدر ليس ملف APK.';

export type MobileNoticeStatus = {
  apkReady: boolean;
};

export function refuseApkReady(status: MobileNoticeStatus): string {
  if (status.apkReady === true) {
    throw new Error('not_an_apk');
  }
  return mobileNotice;
}
