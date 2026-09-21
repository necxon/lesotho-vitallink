FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html config.js style.css favicon.svg lesotho-flag.jpg oip.webp image.png /usr/share/nginx/html/
COPY js/ /usr/share/nginx/html/js/
# LHC-Forms, vendored rather than pulled from a CDN: the portal has to work on a
# server with no outbound internet.
COPY vendor/ /usr/share/nginx/html/vendor/
