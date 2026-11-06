// One-shot authorization for fixed pmset arguments. No shell, password handling,
// installed privileged service, arbitrary executable or caller-supplied command.
#import <Foundation/Foundation.h>
#import <Security/Authorization.h>
#import <Security/AuthorizationTags.h>
static NSString *schedule(void) {
  NSTask *task = [NSTask new]; task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/pmset"];
  task.arguments = @[@"-g", @"sched"]; NSPipe *pipe = [NSPipe pipe]; task.standardOutput = pipe;
  NSError *error = nil; if (![task launchAndReturnError:&error]) return nil;
  NSData *data = [pipe.fileHandleForReading readDataToEndOfFile]; [task waitUntilExit];
  return task.terminationStatus == 0 ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
}
static BOOL safeSchedule(NSString *text, NSString *expected) {
  if (!text) return NO;
  NSRange start = [text rangeOfString:@"Repeating power events:"];
  if (start.location == NSNotFound) return [expected isEqual:@"none"];
  NSString *section = [text substringFromIndex:NSMaxRange(start)];
  section = [[section componentsSeparatedByString:@"Scheduled power events:"] firstObject];
  NSMutableArray *lines = [NSMutableArray array];
  for (NSString *line in [section componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet]) {
    NSString *trimmed = [line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (trimmed.length) [lines addObject:trimmed];
  }
  if (!lines.count) return [expected isEqual:@"none"];
  if (lines.count != 1 || [expected isEqual:@"none"]) return NO;
  NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"^wake at ([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?(AM|PM)? every day$" options:NSRegularExpressionCaseInsensitive error:nil];
  NSString *line = lines[0]; NSTextCheckingResult *m = [re firstMatchInString:line options:0 range:NSMakeRange(0,line.length)];
  if (!m) return NO;
  NSInteger hour = [[line substringWithRange:[m rangeAtIndex:1]] integerValue];
  if ([m rangeAtIndex:4].location != NSNotFound) hour = hour % 12 + ([[[line substringWithRange:[m rangeAtIndex:4]] uppercaseString] isEqual:@"PM"] ? 12 : 0);
  NSString *seconds = [m rangeAtIndex:3].location == NSNotFound ? @"00" : [line substringWithRange:[m rangeAtIndex:3]];
  return [[NSString stringWithFormat:@"%02ld:%@:%@", (long)hour, [line substringWithRange:[m rangeAtIndex:2]], seconds] isEqual:expected];
}
int main(int argc, const char *argv[]) { @autoreleasepool {
  if (argc != 3) return 2;
  NSString *target = @(argv[1]), *expected = @(argv[2]);
  NSPredicate *time = [NSPredicate predicateWithFormat:@"SELF MATCHES %@", @"([01][0-9]|2[0-3]):[0-5][0-9]:00"];
  if ((! [target isEqual:@"cancel"] && ![time evaluateWithObject:target]) || (![expected isEqual:@"none"] && ![time evaluateWithObject:expected])) return 2;
  if (!safeSchedule(schedule(), expected)) { fprintf(stderr,"기존 전원 예약이 변경되었습니다. 덮어쓰지 않았습니다.\n"); return 3; }
  AuthorizationRef auth = NULL;
  OSStatus status = AuthorizationCreate(NULL, kAuthorizationEmptyEnvironment, kAuthorizationFlagDefaults, &auth);
  AuthorizationItem item = { kAuthorizationRightExecute, strlen("/usr/bin/pmset"), (void *)"/usr/bin/pmset", 0 };
  AuthorizationRights rights = { 1, &item };
  if (!status) status = AuthorizationCopyRights(auth, &rights, kAuthorizationEmptyEnvironment, kAuthorizationFlagInteractionAllowed | kAuthorizationFlagExtendRights | kAuthorizationFlagPreAuthorize, NULL);
  if (status) { fprintf(stderr,"Authorization: %d\n",(int)status); if(auth) AuthorizationFree(auth,kAuthorizationFlagDefaults); return 4; }
  // Recheck after the user may have spent minutes in the authentication dialog.
  if (!safeSchedule(schedule(), expected)) { AuthorizationFree(auth,kAuthorizationFlagDefaults); fprintf(stderr,"전원 예약 충돌\n"); return 3; }
  char *enable[] = { "repeat", "wake", "MTWRFSU", (char *)target.UTF8String, NULL };
  char *disable[] = { "repeat", "cancel", NULL };
  FILE *pipe = NULL;
  status = AuthorizationExecuteWithPrivileges(auth, "/usr/bin/pmset", kAuthorizationFlagDefaults, [target isEqual:@"cancel"] ? disable : enable, &pipe);
  if (pipe) { char buffer[512]; while (fgets(buffer,sizeof(buffer),pipe)) fputs(buffer,stdout); fclose(pipe); }
  AuthorizationFree(auth,kAuthorizationFlagDefaults);
  if(status) fprintf(stderr,"Authorization: %d\n",(int)status);
  return status ? 5 : 0;
} }
