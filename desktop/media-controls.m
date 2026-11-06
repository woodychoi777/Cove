#import <Foundation/Foundation.h>
#import <MediaPlayer/MediaPlayer.h>
#include <node_api.h>

static napi_threadsafe_function callback;
static NSMutableArray *targets;
static void deliver(napi_env env, napi_value fn, void *context, void *data) {
  char *json=data;
  if(env && fn) { napi_value value, result; napi_create_string_utf8(env,json,NAPI_AUTO_LENGTH,&value); napi_call_function(env,fn,fn,1,&value,&result); }
  free(json);
}
static void coveSend(NSString *action, NSDictionary *details) {
  if(!callback)return;
  NSMutableDictionary *event=[@{@"action":action} mutableCopy]; if(details)[event addEntriesFromDictionary:details];
  NSData *data=[NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  char *copy=strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
  if(napi_call_threadsafe_function(callback,copy,napi_tsfn_nonblocking)!=napi_ok)free(copy);
}
static void coveBind(MPRemoteCommand *command, NSString *action, BOOL seek) {
  command.enabled=YES;
  id target=[command addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
    NSDictionary *details=nil;
    if(seek && [event isKindOfClass:MPSeekCommandEvent.class]) details=@{@"phase":((MPSeekCommandEvent *)event).type==MPSeekCommandEventTypeBeginSeeking?@"begin":@"end"};
    if([event isKindOfClass:MPSkipIntervalCommandEvent.class]) details=@{@"seekOffset":@(((MPSkipIntervalCommandEvent *)event).interval)};
    if([event isKindOfClass:MPChangePlaybackPositionCommandEvent.class]) details=@{@"seekTime":@(((MPChangePlaybackPositionCommandEvent *)event).positionTime)};
    coveSend(action,details); return MPRemoteCommandHandlerStatusSuccess;
  }];
  [targets addObject:@[command,target]];
}
static void cleanup(void *unused) {
  for(NSArray *pair in targets)[pair[0] removeTarget:pair[1]];
  targets=nil;
  [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo=nil;
  [MPNowPlayingInfoCenter defaultCenter].playbackState=MPNowPlayingPlaybackStateStopped;
  if(callback){napi_release_threadsafe_function(callback,napi_tsfn_abort);callback=NULL;}
}
static napi_value start(napi_env env,napi_callback_info info) {
  size_t count=1;napi_value args[1],name,result;napi_get_cb_info(env,info,&count,args,NULL,NULL);
  napi_valuetype type;if(count!=1 || napi_typeof(env,args[0],&type)!=napi_ok || type!=napi_function){napi_throw_type_error(env,NULL,"A callback is required");return NULL;}
  if(!callback){
    napi_create_string_utf8(env,"Cove media controls",NAPI_AUTO_LENGTH,&name);
    napi_create_threadsafe_function(env,args[0],NULL,name,64,1,NULL,NULL,NULL,deliver,&callback);
    napi_unref_threadsafe_function(env,callback);targets=[NSMutableArray new];
    MPRemoteCommandCenter *c=[MPRemoteCommandCenter sharedCommandCenter];
    coveBind(c.playCommand,@"play",NO);coveBind(c.pauseCommand,@"pause",NO);coveBind(c.togglePlayPauseCommand,@"toggle",NO);coveBind(c.stopCommand,@"stop",NO);
    coveBind(c.nextTrackCommand,@"nexttrack",NO);coveBind(c.previousTrackCommand,@"previoustrack",NO);
    coveBind(c.seekForwardCommand,@"seekforward",YES);coveBind(c.seekBackwardCommand,@"seekbackward",YES);
    c.skipForwardCommand.preferredIntervals=@[@10];c.skipBackwardCommand.preferredIntervals=@[@10];
    coveBind(c.skipForwardCommand,@"seekforward",NO);coveBind(c.skipBackwardCommand,@"seekbackward",NO);coveBind(c.changePlaybackPositionCommand,@"seekto",NO);
    napi_add_env_cleanup_hook(env,cleanup,NULL);
  }
  napi_get_undefined(env,&result);return result;
}
static napi_value update(napi_env env,napi_callback_info info) {
  size_t count=1;napi_value args[1],result;napi_get_cb_info(env,info,&count,args,NULL,NULL);
  size_t size=0;if(count!=1 || napi_get_value_string_utf8(env,args[0],NULL,0,&size)!=napi_ok || size>16000){napi_throw_type_error(env,NULL,"Invalid media state");return NULL;}
  char *buffer=malloc(size+1);napi_get_value_string_utf8(env,args[0],buffer,size+1,&size);
  NSDictionary *state=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:buffer length:size] options:0 error:nil];free(buffer);
  if(![state isKindOfClass:NSDictionary.class]){napi_throw_type_error(env,NULL,"Invalid media state");return NULL;}
  MPNowPlayingInfoCenter *center=[MPNowPlayingInfoCenter defaultCenter];
  if(![state[@"active"] boolValue]){center.nowPlayingInfo=nil;center.playbackState=MPNowPlayingPlaybackStateStopped;}
  else {
    double rate=[state[@"paused"] boolValue]?0:1;
    center.nowPlayingInfo=@{MPMediaItemPropertyTitle:state[@"title"]?:@"",MPMediaItemPropertyArtist:state[@"artist"]?:@"",MPMediaItemPropertyAlbumTitle:state[@"album"]?:@"",MPMediaItemPropertyPlaybackDuration:state[@"duration"]?:@0,MPNowPlayingInfoPropertyElapsedPlaybackTime:state[@"position"]?:@0,MPNowPlayingInfoPropertyPlaybackRate:@(rate),MPNowPlayingInfoPropertyDefaultPlaybackRate:@1,MPNowPlayingInfoPropertyMediaType:@(MPNowPlayingInfoMediaTypeAudio)};
    center.playbackState=rate?MPNowPlayingPlaybackStatePlaying:MPNowPlayingPlaybackStatePaused;
  }
  napi_get_undefined(env,&result);return result;
}
static napi_value status(napi_env env,napi_callback_info info){
  MPNowPlayingInfoCenter *c=[MPNowPlayingInfoCenter defaultCenter];
  NSDictionary *data=@{@"title":c.nowPlayingInfo[MPMediaItemPropertyTitle]?:@"",@"state":@(c.playbackState),@"targets":@(targets.count)};
  NSData *json=[NSJSONSerialization dataWithJSONObject:data options:0 error:nil];napi_value result;napi_create_string_utf8(env,[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String,NAPI_AUTO_LENGTH,&result);return result;
}
static napi_value init(napi_env env,napi_value exports){
  napi_property_descriptor props[]={{"start",0,start,0,0,0,napi_default,0},{"update",0,update,0,0,0,napi_default,0},{"status",0,status,0,0,0,napi_default,0}};
  napi_define_properties(env,exports,3,props);return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
