# Finding out whether slowness is the network or the backend

Add to the `http {}` block of the production Nginx (`10.255.100.61`), then reload:

```nginx
log_format timing '$host $remote_addr "$request" $status $request_time $upstream_response_time';
access_log /var/log/nginx/timing.log timing;
```

Let it collect for a day of normal use, then:

    python scripts/nginx_timing.py /var/log/nginx/timing.log

- **backend** large: the server is slow. Fix that first; QoS will not help.
- **client** large, backend small: the network or the phone is slow.
