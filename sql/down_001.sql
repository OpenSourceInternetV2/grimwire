DROP TYPE basicStatusEnum;
DROP TABLE users CASCADE;
DROP TABLE stations CASCADE;
DROP TABLE apps CASCADE;
DROP TABLE app_auth_tokens CASCADE;
DROP TABLE user_presences CASCADE;
DROP VIEW active_stations_list_view;
DROP VIEW empty_active_stations_list_view;
DROP FUNCTION user_online_stations_fn(_user_id varchar(32));
DROP VIEW station_detail_view;