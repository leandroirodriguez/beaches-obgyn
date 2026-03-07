self.addEventListener("fetch", event => {
  // Always fetch from network — no caching, no interference
  event.respondWith(fetch(event.request));
});

self.addEventListener("push", event => {
  if (!event.data) return;
  const { title, body, data } = event.data.json();
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      vibrate: [100, 50, 100],
      data,
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = data.action || "home";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      const sendNav = () => {
        const bc = new BroadcastChannel("notif_nav");
        bc.postMessage({ type: "NOTIF_NAV", action });
        bc.close();
      };

      if (clientList.length > 0) {
        const client = clientList[0];
        return client.focus().then(() => {
          setTimeout(sendNav, 500);
        });
      } else {
        return clients.openWindow("/?action=" + action).then(() => {
          setTimeout(sendNav, 1500);
        });
      }
    })
  );
});