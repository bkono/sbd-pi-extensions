package com.example.users;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

public final class UserController {
    private static final String DEFAULT_ROLE = "member";
    private static final int MAX_PAGE_SIZE = 100;

    private final UserService service;

    public UserController(UserService service) {
        this.service = Objects.requireNonNull(service);
    }

    @GET
    public List<UserDto> list(@QueryParam("limit") int limit) {
        int safeLimit = Math.min(limit <= 0 ? MAX_PAGE_SIZE : limit, MAX_PAGE_SIZE);
        return service.all().stream()
                .limit(safeLimit)
                .map(UserDto::from)
                .toList();
    }

    @POST
    public UserDto create(CreateUserRequest request) {
        User user = service.register(request.name(), request.role());
        return UserDto.from(user);
    }

    @PATCH
    public UserDto promote(long id) {
        return UserDto.from(service.promote(id));
    }

    public record CreateUserRequest(String name, String role) {
        public CreateUserRequest {
            Objects.requireNonNull(name);
            if (role == null) {
                role = DEFAULT_ROLE;
            }
        }
    }

    public record UserDto(long id, String name, String role, Instant createdAt) {
        public static UserDto from(User user) {
            return new UserDto(user.id(), user.name(), user.role(), user.createdAt());
        }
    }
}

interface UserRepository<U extends User> {
    Optional<U> find(long id);

    List<U> list();

    void save(U user);
}

final class InMemoryUserRepository implements UserRepository<User> {
    private final Map<Long, User> users = new HashMap<>();

    @Override
    public Optional<User> find(long id) {
        return Optional.ofNullable(users.get(id));
    }

    @Override
    public List<User> list() {
        return new ArrayList<>(users.values());
    }

    @Override
    public void save(User user) {
        users.put(user.id(), user);
    }
}

class UserService {
    private final UserRepository<User> repository;
    private final AtomicLong nextId = new AtomicLong(1);

    public UserService(UserRepository<User> repository) {
        this.repository = repository;
    }

    public User register(String name, String role) {
        User user = new User(nextId.getAndIncrement(), name, role, Instant.now());
        repository.save(user);
        return user;
    }

    public User promote(long id) {
        User existing = repository.find(id).orElseThrow(() -> new NotFoundException("user not found"));
        User updated = new User(existing.id(), existing.name(), "admin", existing.createdAt());
        repository.save(updated);
        return updated;
    }

    public List<User> all() {
        return repository.list();
    }

    static class NotFoundException extends RuntimeException {
        NotFoundException(String message) {
            super(message);
        }
    }
}

record User(long id, String name, String role, Instant createdAt) {}

@interface GET {}

@interface POST {}

@interface PATCH {}

@interface QueryParam {
    String value();
}
