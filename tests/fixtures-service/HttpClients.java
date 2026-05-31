package svc;

import java.net.URI;
import java.net.http.HttpRequest;
import org.springframework.web.client.RestTemplate;

public class HttpClients {
    private final RestTemplate restTemplate = new RestTemplate();

    // RestTemplate getForObject — should record GET /api/users via spring-rest.
    public String listUsers() {
        return restTemplate.getForObject("/api/users", String.class);
    }

    // postForObject — POST /api/orders via spring-rest.
    public String createOrder(Object body) {
        return restTemplate.postForObject("/api/orders", body, String.class);
    }

    // java.net.http HttpRequest.newBuilder(URI.create("..."))
    public HttpRequest buildPing() {
        return HttpRequest.newBuilder(URI.create("https://payment-service/api/ping")).build();
    }
}
